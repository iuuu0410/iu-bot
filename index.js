const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  Events,
} = require('discord.js');

const { TOKEN } = require('./config.json');

const DATA_FILE = path.join(__dirname, 'botData.json');

const INITIAL_SHELL = 30000;
const VOICE_HOURLY_REWARD = 500;
const VOICE_TEN_HOURS_BONUS = 2000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TEN_HOUR_MS = 10 * ONE_HOUR_MS;

const ROOM_OPTIONS = {
  normal_12: { type: 'normal', hours: 12, price: 10000 },
  normal_24: { type: 'normal', hours: 24, price: 20000 },
  private_12: { type: 'private', hours: 12, price: 30000 },
  private_24: { type: 'private', hours: 24, price: 50000 },
};

function createDefaultData() {
  return {
    balances: {},
    initialClaimed: {},
    initialLogChannelId: null,
    normalRoomVisibleRoleId: null,
    rooms: {
      normal: {},
      private: {},
    },
    voice: {
      appliedCategoryIds: [],
      users: {},
      sessions: {},
    },
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = createDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), 'utf8');
    return init;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const defaults = createDefaultData();

    return {
      ...defaults,
      ...parsed,
      rooms: {
        ...defaults.rooms,
        ...(parsed.rooms || {}),
      },
      voice: {
        ...defaults.voice,
        ...(parsed.voice || {}),
      },
    };
  } catch (error) {
    console.error('botData.json の読み込みに失敗したため初期化します:', error);
    const init = createDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), 'utf8');
    return init;
  }
}

let data = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureVoiceData() {
  if (!data.voice || typeof data.voice !== 'object') data.voice = {};
  if (!Array.isArray(data.voice.appliedCategoryIds)) data.voice.appliedCategoryIds = [];
  if (!data.voice.users || typeof data.voice.users !== 'object') data.voice.users = {};
  if (!data.voice.sessions || typeof data.voice.sessions !== 'object') data.voice.sessions = {};
}

function ensureBalance(userId) {
  if (typeof data.balances[userId] !== 'number') {
    data.balances[userId] = 0;
  }
}

function ensureVoiceUser(userId) {
  ensureVoiceData();
  if (!data.voice.users[userId]) {
    data.voice.users[userId] = {
      totalMs: 0,
      awardedHours: 0,
      tenHourBonusGiven: false,
    };
  }
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function formatMs(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}時間${minutes}分${seconds}秒`;
}

function sanitizeChannelName(name) {
  return (name || 'room')
    .replace(/[\\/:*?"<>|#,@`]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 90) || 'room';
}

function getMentionRoles(member) {
  if (!member || !member.roles) return 'ロールなし';

  const roles = member.roles.cache
    .filter(role => role.name !== '@everyone')
    .map(role => `<@&${role.id}>`);

  return roles.length ? roles.join(' ') : 'ロールなし';
}

function makeTransferEmbed(title, description, fields = []) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .addFields(fields)
        .setTimestamp(),
    ],
  };
}

function getRoomRecord(type, ownerId) {
  return data.rooms?.[type]?.[ownerId] || null;
}

function deleteRoomRecord(type, ownerId) {
  if (data.rooms?.[type]?.[ownerId]) {
    delete data.rooms[type][ownerId];
    saveData();
  }
}

async function safelyDeleteRoom(client, roomInfo, type, ownerId) {
  try {
    const guild = await client.guilds.fetch(roomInfo.guildId).catch(() => null);
    if (!guild) {
      deleteRoomRecord(type, ownerId);
      return;
    }

    const channel = await guild.channels.fetch(roomInfo.channelId).catch(() => null);
    if (!channel) {
      deleteRoomRecord(type, ownerId);
      return;
    }

    await channel.delete('利用時間満了による自動削除');
    deleteRoomRecord(type, ownerId);
  } catch (error) {
    console.error('部屋削除エラー:', error);
  }
}

function scheduleRoomDeletion(client, roomInfo, type, ownerId) {
  const delay = roomInfo.expiresAt - Date.now();

  if (delay <= 0) {
    safelyDeleteRoom(client, roomInfo, type, ownerId);
    return;
  }

  setTimeout(async () => {
    const latest = getRoomRecord(type, ownerId);
    if (!latest) return;
    if (latest.channelId !== roomInfo.channelId) return;

    const guild = await client.guilds.fetch(latest.guildId).catch(() => null);
    if (!guild) {
      deleteRoomRecord(type, ownerId);
      return;
    }

    const channel = await guild.channels.fetch(latest.channelId).catch(() => null);
    if (!channel) {
      deleteRoomRecord(type, ownerId);
      return;
    }

    await safelyDeleteRoom(client, latest, type, ownerId);
  }, delay);
}

function isVoiceCategoryApplied(channel) {
  ensureVoiceData();

  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice) return false;
  if (!channel.parentId) return false;

  return data.voice.appliedCategoryIds.includes(channel.parentId);
}

function isCountableVoiceState(state) {
  if (!state || !state.channel) return false;
  if (!isVoiceCategoryApplied(state.channel)) return false;
  if (state.selfMute || state.serverMute) return false;
  return true;
}

function addVoiceTimeAndRewards(userId, diffMs) {
  if (diffMs <= 0) return;

  ensureVoiceUser(userId);
  ensureBalance(userId);

  const voiceUser = data.voice.users[userId];
  voiceUser.totalMs += diffMs;

  const currentHours = Math.floor(voiceUser.totalMs / ONE_HOUR_MS);
  if (currentHours > voiceUser.awardedHours) {
    const gainedHours = currentHours - voiceUser.awardedHours;
    data.balances[userId] += gainedHours * VOICE_HOURLY_REWARD;
    voiceUser.awardedHours = currentHours;
  }

  if (!voiceUser.tenHourBonusGiven && voiceUser.totalMs >= TEN_HOUR_MS) {
    data.balances[userId] += VOICE_TEN_HOURS_BONUS;
    voiceUser.tenHourBonusGiven = true;
  }
}

function startVoiceSession(member, channel) {
  if (!member || !channel) return;

  ensureVoiceData();

  const now = Date.now();
  data.voice.sessions[member.id] = {
    guildId: channel.guild.id,
    channelId: channel.id,
    lastTick: now,
  };
  saveData();
}

function stopVoiceSession(userId) {
  ensureVoiceData();

  if (data.voice.sessions[userId]) {
    delete data.voice.sessions[userId];
    saveData();
  }
}

function tickVoiceSessions(client) {
  ensureVoiceData();

  const now = Date.now();
  let changed = false;

  for (const [userId, session] of Object.entries(data.voice.sessions)) {
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) {
      delete data.voice.sessions[userId];
      changed = true;
      continue;
    }

    const member = guild.members.cache.get(userId);
    if (!member || !member.voice?.channel) {
      delete data.voice.sessions[userId];
      changed = true;
      continue;
    }

    if (!isCountableVoiceState(member.voice)) {
      session.lastTick = now;
      changed = true;
      continue;
    }

    const diff = now - (session.lastTick || now);
    if (diff > 0) {
      addVoiceTimeAndRewards(userId, diff);
      session.lastTick = now;
      changed = true;
    }
  }

  if (changed) saveData();
}

async function rebuildRoomSchedules(client) {
  for (const [ownerId, roomInfo] of Object.entries(data.rooms.normal || {})) {
    scheduleRoomDeletion(client, roomInfo, 'normal', ownerId);
  }

  for (const [ownerId, roomInfo] of Object.entries(data.rooms.private || {})) {
    scheduleRoomDeletion(client, roomInfo, 'private', ownerId);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async () => {
  ensureVoiceData();
  saveData();

  console.log(`${client.user.tag} でログインしました`);

  await rebuildRoomSchedules(client);

  setInterval(() => {
    tickVoiceSessions(client);
  }, 60 * 1000);
});

client.on(Events.ChannelDelete, async channel => {
  for (const [ownerId, roomInfo] of Object.entries(data.rooms.normal || {})) {
    if (roomInfo.channelId === channel.id) {
      deleteRoomRecord('normal', ownerId);
      break;
    }
  }

  for (const [ownerId, roomInfo] of Object.entries(data.rooms.private || {})) {
    if (roomInfo.channelId === channel.id) {
      deleteRoomRecord('private', ownerId);
      break;
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    ensureVoiceData();

    const userId = newState.id;
    const hasSession = !!data.voice.sessions[userId];

    if (hasSession) {
      const session = data.voice.sessions[userId];
      const now = Date.now();
      const diff = now - (session.lastTick || now);

      if (diff > 0 && isCountableVoiceState(oldState)) {
        addVoiceTimeAndRewards(userId, diff);
      }

      if (data.voice.sessions[userId]) {
        data.voice.sessions[userId].lastTick = now;
      }

      saveData();
    }

    if (isCountableVoiceState(newState)) {
      startVoiceSession(newState.member, newState.channel);
    } else {
      stopVoiceSession(userId);
    }
  } catch (error) {
    console.error('VoiceStateUpdate エラー:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === '発行') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const target = interaction.options.getUser('ユーザー', true);
        const amount = interaction.options.getInteger('金額', true);

        ensureBalance(target.id);
        data.balances[target.id] += amount;
        saveData();

        return interaction.reply({
          content: `✅ ${target} に **${amount.toLocaleString()}shell** を発行しました。`,
          ephemeral: true,
        });
      }

      if (commandName === '給与') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const role = interaction.options.getRole('ロール', true);
        const amount = interaction.options.getInteger('金額', true);

        const members = interaction.guild.members.cache.filter(
          member => !member.user.bot && member.roles.cache.has(role.id)
        );

        if (members.size === 0) {
          return interaction.reply({
            content: '対象ロールのメンバーがいません。',
            ephemeral: true,
          });
        }

        for (const member of members.values()) {
          ensureBalance(member.id);
          data.balances[member.id] += amount;
        }
        saveData();

        return interaction.reply(
          makeTransferEmbed('給与支給', `${role} のメンバーへ給与を支給しました。`, [
            { name: '対象ロール', value: `${role}`, inline: true },
            { name: '対象人数', value: `${members.size}人`, inline: true },
            { name: '支給額', value: `${amount.toLocaleString()}shell`, inline: true },
            { name: '実行者', value: `${interaction.user}`, inline: false },
          ])
        );
      }

      if (commandName === '初期発行') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('initial_claim_button')
            .setLabel('初期発行を申請')
            .setStyle(ButtonStyle.Success)
        );

        return interaction.reply({
          content: '下のボタンから初期発行を申請できます。',
          components: [row],
        });
      }

      if (commandName === '初期発行リセット') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const target = interaction.options.getUser('ユーザー', true);
        delete data.initialClaimed[target.id];
        saveData();

        return interaction.reply({
          content: `✅ ${target.username} の初期発行をリセットしました。`,
          ephemeral: true,
        });
      }

      if (commandName === '初期発行ログ') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const channel = interaction.options.getChannel('チャンネル', true);

        if (channel.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: 'テキストチャンネルを指定してください。',
            ephemeral: true,
          });
        }

        data.initialLogChannelId = channel.id;
        saveData();

        return interaction.reply({
          content: `✅ 初期発行ログの送信先を ${channel} に設定しました。`,
          ephemeral: true,
        });
      }

      if (commandName === '送金') {
        const target = interaction.options.getUser('ユーザー', true);
        const amount = interaction.options.getInteger('金額', true);

        if (target.bot) {
          return interaction.reply({ content: 'Botには送金できません。', ephemeral: true });
        }

        if (target.id === interaction.user.id) {
          return interaction.reply({ content: '自分自身には送金できません。', ephemeral: true });
        }

        ensureBalance(interaction.user.id);
        ensureBalance(target.id);

        if (data.balances[interaction.user.id] < amount) {
          return interaction.reply({ content: '残高が不足しています。', ephemeral: true });
        }

        data.balances[interaction.user.id] -= amount;
        data.balances[target.id] += amount;
        saveData();

        const senderMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

        return interaction.reply(
          makeTransferEmbed('送金', `${interaction.user} から ${target} へ送金されました。`, [
            {
              name: '送金者',
              value: `${interaction.user}\n${getMentionRoles(senderMember)}`,
              inline: true,
            },
            {
              name: '受取者',
              value: `${target}\n${getMentionRoles(targetMember)}`,
              inline: true,
            },
            {
              name: '金額',
              value: `${amount.toLocaleString()}shell`,
              inline: false,
            },
          ])
        );
      }

      if (commandName === '残高') {
        ensureBalance(interaction.user.id);

        return interaction.reply({
          content: `💰 あなたの残高は **${data.balances[interaction.user.id].toLocaleString()}shell** です。`,
          ephemeral: true,
        });
      }

      if (commandName === '部屋作成') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('room_create_normal_12')
            .setLabel('12時間 10000shell')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('room_create_normal_24')
            .setLabel('24時間 20000shell')
            .setStyle(ButtonStyle.Primary)
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('room_create_private_12')
            .setLabel('12時間 30000shell')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('room_create_private_24')
            .setLabel('24時間 50000shell')
            .setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({
          content: '作成する部屋を選択してください。',
          components: [row1, row2],
        });
      }

      if (commandName === '部屋作成ロール指定') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const role = interaction.options.getRole('ロール', true);
        data.normalRoomVisibleRoleId = role.id;
        saveData();

        return interaction.reply({
          content: `✅ 普通部屋が見えるロールを ${role} に設定しました。`,
          ephemeral: true,
        });
      }

      if (commandName === '浮上適用') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('voice_apply_open')
            .setLabel('適用設定')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('voice_unapply_open')
            .setLabel('適用解除')
            .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
          content: '浮上時間カウントの設定を選択してください。',
          components: [row],
          ephemeral: true,
        });
      }

      if (commandName === 'ランキング') {
        ensureVoiceData();
        ensureVoiceUser(interaction.user.id);

        await interaction.deferReply({ ephemeral: true });

        const myData = data.voice.users[interaction.user.id] || {
          totalMs: 0,
          awardedHours: 0,
          tenHourBonusGiven: false,
        };

        const top = Object.entries(data.voice.users)
          .filter(([_, info]) => info && typeof info.totalMs === 'number')
          .sort((a, b) => (b[1].totalMs || 0) - (a[1].totalMs || 0))
          .slice(0, 10);

        const lines = top.length
          ? top.map(([userId, info], index) =>
              `${index + 1}位: <@${userId}> - ${formatMs(info.totalMs || 0)}`
            ).join('\n')
          : 'まだデータがありません。';

        return interaction.editReply({
          content:
            `**あなたの浮上時間**\n<@${interaction.user.id}> - ${formatMs(myData.totalMs || 0)}\n\n` +
            `**TOP10**\n${lines}`,
        });
      }

      if (commandName === 'ランキングリセット') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'このコマンドは管理者専用です。', ephemeral: true });
        }

        ensureVoiceData();
        data.voice.users = {};
        data.voice.sessions = {};
        saveData();

        return interaction.reply({
          content: '@everyone 浮上時間がリセットされました',
          allowedMentions: { parse: ['everyone'] },
        });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'initial_claim_button') {
        if (data.initialClaimed[interaction.user.id]) {
          return interaction.reply({
            content: '初期発行を受け取り済みです。',
            ephemeral: true,
          });
        }

        ensureBalance(interaction.user.id);
        data.balances[interaction.user.id] += INITIAL_SHELL;
        data.initialClaimed[interaction.user.id] = true;
        saveData();

        await interaction.reply(
          makeTransferEmbed('初期発行', `${interaction.user} が初期発行を受け取りました。`, [
            { name: '受取者', value: `${interaction.user}`, inline: true },
            { name: '金額', value: `${INITIAL_SHELL.toLocaleString()}shell`, inline: true },
          ])
        );

        if (data.initialLogChannelId) {
          const logChannel = await interaction.guild.channels.fetch(data.initialLogChannelId).catch(() => null);
          if (logChannel && logChannel.isTextBased()) {
            await logChannel.send({
              content: `📝 初期発行ログ\n受取者: ${interaction.user}\n金額: ${INITIAL_SHELL.toLocaleString()}shell`,
            }).catch(() => null);
          }
        }

        return;
      }

      if (interaction.customId.startsWith('room_create_')) {
        const key = interaction.customId.replace('room_create_', '');
        const option = ROOM_OPTIONS[key];

        if (!option) {
          return interaction.reply({ content: '不正な部屋タイプです。', ephemeral: true });
        }

        ensureBalance(interaction.user.id);

        const existing = getRoomRecord(option.type, interaction.user.id);
        if (existing) {
          const existingChannel = await interaction.guild.channels.fetch(existing.channelId).catch(() => null);
          if (existingChannel) {
            return interaction.reply({ content: '既に部屋を作成済みです。', ephemeral: true });
          }
          deleteRoomRecord(option.type, interaction.user.id);
        }

        if (data.balances[interaction.user.id] < option.price) {
          return interaction.reply({ content: '残高が不足しています。', ephemeral: true });
        }

        const parentId = interaction.channel.parentId || null;
        let permissionOverwrites = [];

        if (option.type === 'normal') {
          if (!data.normalRoomVisibleRoleId) {
            return interaction.reply({
              content: '普通部屋が見えるロールが未設定です。管理者に設定してもらってください。',
              ephemeral: true,
            });
          }

          permissionOverwrites = [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
              ],
            },
            {
              id: data.normalRoomVisibleRoleId,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
              ],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ManageChannels,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.ManageRoles,
              ],
            },
          ];
        }

        if (option.type === 'private') {
          permissionOverwrites = [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
              ],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ManageChannels,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.ManageRoles,
              ],
            },
          ];
        }

        const roomName = sanitizeChannelName(
          option.type === 'normal'
            ? `N-${interaction.user.username}の部屋`
            : `S-${interaction.user.username}の部屋`
        );

        const roomChannel = await interaction.guild.channels.create({
          name: roomName,
          type: ChannelType.GuildVoice,
          parent: parentId,
          userLimit: 2,
          permissionOverwrites,
          reason: `${interaction.user.tag} による部屋作成`,
        });

        data.balances[interaction.user.id] -= option.price;

        const roomInfo = {
          ownerId: interaction.user.id,
          channelId: roomChannel.id,
          guildId: interaction.guild.id,
          type: option.type,
          price: option.price,
          hours: option.hours,
          createdAt: Date.now(),
          expiresAt: Date.now() + option.hours * 60 * 60 * 1000,
        };

        data.rooms[option.type][interaction.user.id] = roomInfo;
        saveData();
        scheduleRoomDeletion(client, roomInfo, option.type, interaction.user.id);

        const rows = [];

        if (option.type === 'normal') {
          rows.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`normal_room_rename|${roomChannel.id}|${interaction.user.id}`)
                .setLabel('部屋名変更')
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId(`normal_room_limit|${roomChannel.id}|${interaction.user.id}`)
                .setLabel('人数制限変更')
                .setStyle(ButtonStyle.Secondary)
            )
          );
        }

        if (option.type === 'private') {
          rows.push(
            new ActionRowBuilder().addComponents(
              new UserSelectMenuBuilder()
                .setCustomId(`private_room_invite|${roomChannel.id}|${interaction.user.id}`)
                .setPlaceholder('招待するユーザーを選択')
                .setMinValues(1)
                .setMaxValues(10)
            )
          );
        }

        return interaction.reply({
          content:
            `✅ ${roomChannel} を作成しました。\n` +
            `料金: ${option.price.toLocaleString()}shell\n` +
            `削除予定: ${option.hours}時間後`,
          components: rows,
          ephemeral: true,
        });
      }

      if (interaction.customId === 'voice_apply_open') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: '管理者専用です。', ephemeral: true });
        }

        const categories = interaction.guild.channels.cache
          .filter(channel => channel.type === ChannelType.GuildCategory)
          .map(channel => ({
            label: channel.name.slice(0, 100),
            value: channel.id,
            description: data.voice.appliedCategoryIds.includes(channel.id) ? '適用済み' : '未適用',
          }))
          .slice(0, 25);

        if (!categories.length) {
          return interaction.reply({ content: 'カテゴリがありません。', ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('voice_apply_select')
            .setPlaceholder('適用するカテゴリを選択')
            .addOptions(categories)
        );

        return interaction.reply({
          content: '浮上時間カウントを適用するカテゴリを選択してください。',
          components: [row],
          ephemeral: true,
        });
      }

      if (interaction.customId === 'voice_unapply_open') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: '管理者専用です。', ephemeral: true });
        }

        const categories = interaction.guild.channels.cache
          .filter(channel =>
            channel.type === ChannelType.GuildCategory &&
            data.voice.appliedCategoryIds.includes(channel.id)
          )
          .map(channel => ({
            label: channel.name.slice(0, 100),
            value: channel.id,
            description: '適用解除',
          }))
          .slice(0, 25);

        if (!categories.length) {
          return interaction.reply({
            content: '現在、適用されているカテゴリはありません。',
            ephemeral: true,
          });
        }

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('voice_unapply_select')
            .setPlaceholder('適用解除するカテゴリを選択')
            .addOptions(categories)
        );

        return interaction.reply({
          content: '適用解除するカテゴリを選択してください。',
          components: [row],
          ephemeral: true,
        });
      }

      if (interaction.customId.startsWith('normal_room_rename|')) {
        const [, channelId, ownerId] = interaction.customId.split('|');

        if (interaction.user.id !== ownerId) {
          return interaction.reply({ content: '部屋作成者のみ使用できます。', ephemeral: true });
        }

        const room = data.rooms.normal[ownerId];
        if (!room || room.channelId !== channelId) {
          return interaction.reply({ content: '対象の部屋が見つかりません。', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`modal_room_rename|${channelId}|${ownerId}`)
          .setTitle('部屋名変更');

        const input = new TextInputBuilder()
          .setCustomId('new_room_name')
          .setLabel('新しい部屋名')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(90)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId.startsWith('normal_room_limit|')) {
        const [, channelId, ownerId] = interaction.customId.split('|');

        if (interaction.user.id !== ownerId) {
          return interaction.reply({ content: '部屋作成者のみ使用できます。', ephemeral: true });
        }

        const room = data.rooms.normal[ownerId];
        if (!room || room.channelId !== channelId) {
          return interaction.reply({ content: '対象の部屋が見つかりません。', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`modal_room_limit|${channelId}|${ownerId}`)
          .setTitle('人数制限変更');

        const input = new TextInputBuilder()
          .setCustomId('new_user_limit')
          .setLabel('人数制限（解除する場合は0）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0〜99')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'voice_apply_select') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: '管理者専用です。', ephemeral: true });
        }

        const categoryId = interaction.values[0];

        if (data.voice.appliedCategoryIds.includes(categoryId)) {
          return interaction.reply({
            content: 'そのカテゴリは既に適用されています。',
            ephemeral: true,
          });
        }

        data.voice.appliedCategoryIds.push(categoryId);
        saveData();

        const category = interaction.guild.channels.cache.get(categoryId);
        return interaction.reply({
          content: `✅ ${category ? category.name : '不明なカテゴリ'} に適用しました。`,
          ephemeral: true,
        });
      }

      if (interaction.customId === 'voice_unapply_select') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: '管理者専用です。', ephemeral: true });
        }

        const categoryId = interaction.values[0];

        if (!data.voice.appliedCategoryIds.includes(categoryId)) {
          return interaction.reply({
            content: 'そのカテゴリは適用されていません。',
            ephemeral: true,
          });
        }

        data.voice.appliedCategoryIds = data.voice.appliedCategoryIds.filter(id => id !== categoryId);
        saveData();

        const category = interaction.guild.channels.cache.get(categoryId);
        return interaction.reply({
          content: `✅ ${category ? category.name : '不明なカテゴリ'} の適用を解除しました。`,
          ephemeral: true,
        });
      }
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId.startsWith('private_room_invite|')) {
        const [, channelId, ownerId] = interaction.customId.split('|');

        if (interaction.user.id !== ownerId) {
          return interaction.reply({
            content: 'この招待UIは部屋作成者のみ使用できます。',
            ephemeral: true,
          });
        }

        const room = data.rooms.private[ownerId];
        if (!room || room.channelId !== channelId) {
          return interaction.reply({ content: '対象の部屋が見つかりません。', ephemeral: true });
        }

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          deleteRoomRecord('private', ownerId);
          return interaction.reply({ content: '対象の部屋は存在しません。', ephemeral: true });
        }

        const inviteIds = interaction.values.filter(id => id !== ownerId);
        if (!inviteIds.length) {
          return interaction.reply({ content: '招待対象が選択されていません。', ephemeral: true });
        }

        for (const userId of inviteIds) {
          await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
          }).catch(() => null);
        }

        return interaction.reply({
          content: `✅ 招待しました: ${inviteIds.map(id => `<@${id}>`).join(', ')}`,
          ephemeral: true,
        });
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('modal_room_rename|')) {
        const [, channelId, ownerId] = interaction.customId.split('|');

        if (interaction.user.id !== ownerId) {
          return interaction.reply({ content: '部屋作成者のみ変更できます。', ephemeral: true });
        }

        const room = data.rooms.normal[ownerId];
        if (!room || room.channelId !== channelId) {
          return interaction.reply({ content: '対象の部屋が見つかりません。', ephemeral: true });
        }

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          deleteRoomRecord('normal', ownerId);
          return interaction.reply({ content: '対象の部屋は存在しません。', ephemeral: true });
        }

        const newName = sanitizeChannelName(interaction.fields.getTextInputValue('new_room_name'));
        await channel.setName(newName).catch(() => null);

        return interaction.reply({
          content: `✅ 部屋名を **${newName}** に変更しました。`,
          ephemeral: true,
        });
      }

      if (interaction.customId.startsWith('modal_room_limit|')) {
        const [, channelId, ownerId] = interaction.customId.split('|');

        if (interaction.user.id !== ownerId) {
          return interaction.reply({ content: '部屋作成者のみ変更できます。', ephemeral: true });
        }

        const room = data.rooms.normal[ownerId];
        if (!room || room.channelId !== channelId) {
          return interaction.reply({ content: '対象の部屋が見つかりません。', ephemeral: true });
        }

        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          deleteRoomRecord('normal', ownerId);
          return interaction.reply({ content: '対象の部屋は存在しません。', ephemeral: true });
        }

        const value = Number(interaction.fields.getTextInputValue('new_user_limit'));

        if (!Number.isInteger(value) || value < 0 || value > 99) {
          return interaction.reply({
            content: '人数制限は 0〜99 の整数で入力してください。',
            ephemeral: true,
          });
        }

        await channel.setUserLimit(value).catch(() => null);

        return interaction.reply({
          content: `✅ 人数制限を **${value === 0 ? '解除' : `${value}人`}** に変更しました。`,
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error('Interaction エラー:', error);

    if (interaction.replied || interaction.deferred) {
      try {
        await interaction.followUp({
          content: 'エラーが発生しました。',
          ephemeral: true,
        });
      } catch {}
    } else {
      try {
        await interaction.reply({
          content: 'エラーが発生しました。',
          ephemeral: true,
        });
      } catch {}
    }
  }
});

client.login(TOKEN);