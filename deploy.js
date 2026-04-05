const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const { TOKEN, CLIENT_ID, GUILD_ID } = require('./config.json');

const ADMIN = PermissionFlagsBits.Administrator;

const commands = [
  new SlashCommandBuilder()
    .setName('発行')
    .setDescription('指定したユーザーにshellを発行します')
    .addUserOption(option =>
      option.setName('ユーザー').setDescription('発行先ユーザー').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('金額').setDescription('発行額').setRequired(true).setMinValue(1)
    )
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('給与')
    .setDescription('指定したロールの全員に給与を送金します')
    .addRoleOption(option =>
      option.setName('ロール').setDescription('対象ロール').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('金額').setDescription('1人あたりの金額').setRequired(true).setMinValue(1)
    )
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('初期発行')
    .setDescription('初期発行申請ボタンUIを表示します')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('初期発行リセット')
    .setDescription('指定したユーザーの初期発行受取状態をリセットします')
    .addUserOption(option =>
      option.setName('ユーザー').setDescription('対象ユーザー').setRequired(true)
    )
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('初期発行ログ')
    .setDescription('初期発行ログの送信先チャンネルを設定します')
    .addChannelOption(option =>
      option
        .setName('チャンネル')
        .setDescription('ログ送信先テキストチャンネル')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('送金')
    .setDescription('他のユーザーへshellを送金します')
    .addUserOption(option =>
      option.setName('ユーザー').setDescription('送金先ユーザー').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('金額').setDescription('送金額').setRequired(true).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('残高')
    .setDescription('自分の残高を確認します'),

  new SlashCommandBuilder()
    .setName('部屋作成')
    .setDescription('部屋作成ボタンUIを表示します')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('部屋作成ロール指定')
    .setDescription('普通部屋が見えるロールを指定します')
    .addRoleOption(option =>
      option.setName('ロール').setDescription('普通部屋が見えるロール').setRequired(true)
    )
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('浮上適用')
    .setDescription('浮上時間カウントを適用するカテゴリを設定・解除します')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder()
    .setName('ランキング')
    .setDescription('自分の浮上時間とTOP10を表示します'),

  new SlashCommandBuilder()
    .setName('ランキングリセット')
    .setDescription('全ユーザーの浮上時間をリセットします')
    .setDefaultMemberPermissions(ADMIN),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('スラッシュコマンドを登録中...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('スラッシュコマンドの登録が完了しました。');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
})();