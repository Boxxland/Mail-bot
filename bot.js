// bot.js — Mail Bot
// Slash Commands:
//   /register username:ชื่อ          — สมัครบัญชี Mail Bot (modal กรอก username)
//   /mail user:@คน message:ข้อความ   — ส่งข้อความหา user
//   /mailbox                         — ดูข้อความที่เคยได้รับ (10 รายการล่าสุด)
//   /reply message:ข้อความ           — ตอบกลับข้อความล่าสุดที่ได้รับ
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');
const pool = require('./db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`✅ Mail Bot online: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'register') return openRegisterModal(interaction);
    if (interaction.commandName === 'mail') return handleMail(interaction);
    if (interaction.commandName === 'mailbox') return handleMailbox(interaction);
    if (interaction.commandName === 'reply') return handleReply(interaction);
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'mailRegisterModal') return handleRegisterSubmit(interaction);
  }
});

// ---------- /register ----------
function openRegisterModal(interaction) {
  const modal = new ModalBuilder().setCustomId('mailRegisterModal').setTitle('สมัครบัญชี Mail Bot');

  const usernameInput = new TextInputBuilder()
    .setCustomId('username')
    .setLabel('Username ที่ต้องการ (a-z, 0-9, _)')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(20)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
  return interaction.showModal(modal);
}

async function handleRegisterSubmit(interaction) {
  const username = interaction.fields.getTextInputValue('username').trim();

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return interaction.reply({ content: '⚠️ username ต้องเป็น a-z, 0-9, _ เท่านั้น (3-20 ตัว)', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const existingByDiscord = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [interaction.user.id]
    );
    if (existingByDiscord.rows.length > 0) {
      return interaction.editReply(`⚠️ คุณลงทะเบียน Mail Bot ไว้แล้วในชื่อ \`${existingByDiscord.rows[0].username}\``);
    }

    const existingByUsername = await pool.query(
      'SELECT discord_id FROM mailnot_users WHERE username = $1',
      [username]
    );
    if (existingByUsername.rows.length > 0) {
      return interaction.editReply(`⚠️ username \`${username}\` มีคนใช้แล้ว ลองชื่ออื่นนะ`);
    }

    await pool.query(
      'INSERT INTO mailnot_users (discord_id, username) VALUES ($1, $2)',
      [interaction.user.id, username]
    );

    return interaction.editReply(
      `✅ ลงทะเบียน Mail Bot สำเร็จ! ตอนนี้คนอื่นจะเห็นคุณในชื่อ \`${username}\` เวลาส่ง/รับเมล 📬`
    );
  } catch (err) {
    console.error('Register error:', err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด ลองอีกครั้งนะ');
  }
}

// ---------- /mail user:@คน message:ข้อความ ----------
async function handleMail(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const senderResult = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [interaction.user.id]
    );
    const sender = senderResult.rows[0];
    if (!sender) {
      return interaction.editReply('⚠️ คุณยังไม่ได้ลงทะเบียน Mail Bot — ใช้ `/register` ก่อนนะ');
    }

    const target = interaction.options.getUser('user');
    const messageText = interaction.options.getString('message');

    if (target.bot) return interaction.editReply('⚠️ ส่งหาบอทตัวอื่นไม่ได้นะ');
    if (target.id === interaction.user.id) return interaction.editReply('⚠️ ส่งหาตัวเองทำไมล่ะ 😄');

    const recipientResult = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [target.id]
    );
    const recipient = recipientResult.rows[0];
    if (!recipient) {
      return interaction.editReply(`⚠️ ${target.tag} ยังไม่ได้ลงทะเบียน Mail Bot เลย ส่งหาไม่ได้นะ`);
    }

    return deliverMail(interaction, sender, target, recipient, messageText);
  } catch (err) {
    console.error('Mail error:', err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด ลองอีกครั้งนะ');
  }
}

// ---------- /reply message:ข้อความ ----------
async function handleReply(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const senderResult = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [interaction.user.id]
    );
    const sender = senderResult.rows[0];
    if (!sender) {
      return interaction.editReply('⚠️ คุณยังไม่ได้ลงทะเบียน Mail Bot — ใช้ `/register` ก่อนนะ');
    }

    const messageText = interaction.options.getString('message');

    const lastMsgResult = await pool.query(
      'SELECT * FROM mailnot_messages WHERE to_discord_id = $1 ORDER BY created_at DESC LIMIT 1',
      [interaction.user.id]
    );
    const lastMsg = lastMsgResult.rows[0];
    if (!lastMsg) {
      return interaction.editReply('⚠️ คุณยังไม่เคยได้รับข้อความเลย ไม่มีอะไรให้ตอบ');
    }

    const target = await client.users.fetch(lastMsg.from_discord_id).catch(() => null);
    if (!target) {
      return interaction.editReply('⚠️ หาผู้ใช้ที่จะตอบไม่เจอ (อาจออกจากเซิร์ฟไปแล้ว)');
    }

    const recipientResult = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [target.id]
    );
    const recipient = recipientResult.rows[0];
    if (!recipient) {
      return interaction.editReply('⚠️ คนที่คุณจะตอบยกเลิกการลงทะเบียน Mail Bot ไปแล้ว');
    }

    return deliverMail(interaction, sender, target, recipient, messageText);
  } catch (err) {
    console.error('Reply error:', err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด ลองอีกครั้งนะ');
  }
}

// ---------- ฟังก์ชันกลาง ใช้ส่งจริงทั้งจาก /mail และ /reply ----------
async function deliverMail(interaction, sender, targetUser, recipientRecord, messageText) {
  try {
    await targetUser.send(
      `📩 **ข้อความใหม่จาก \`${sender.username}\`** (Mail Bot)\n\n` +
      `${messageText}\n\n` +
      `— ตอบกลับด้วย \`/reply\` ได้เลย`
    );
    await pool.query(
      'INSERT INTO mailnot_messages (from_discord_id, to_discord_id, body) VALUES ($1, $2, $3)',
      [interaction.user.id, targetUser.id, messageText]
    );
    return interaction.editReply(`✅ ส่งถึง \`${recipientRecord.username}\` แล้ว 📨`);
  } catch (err) {
    return interaction.editReply(`⚠️ ส่งหา \`${recipientRecord.username}\` ไม่ได้ — เขาอาจปิดรับ DM จากสมาชิกเซิร์ฟไว้`);
  }
}

// ---------- /mailbox ----------
async function handleMailbox(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const userResult = await pool.query(
      'SELECT * FROM mailnot_users WHERE discord_id = $1',
      [interaction.user.id]
    );
    const user = userResult.rows[0];
    if (!user) {
      return interaction.editReply('⚠️ คุณยังไม่ได้ลงทะเบียน Mail Bot — ใช้ `/register` ก่อนนะ');
    }

    const inboxResult = await pool.query(
      'SELECT * FROM mailnot_messages WHERE to_discord_id = $1 ORDER BY created_at DESC LIMIT 10',
      [interaction.user.id]
    );
    const inbox = inboxResult.rows;

    if (inbox.length === 0) {
      return interaction.editReply('📭 กล่องข้อความว่างเปล่า ยังไม่มีใครส่งหาคุณเลย');
    }

    const fields = [];
    for (const m of inbox) {
      const fromResult = await pool.query(
        'SELECT username FROM mailnot_users WHERE discord_id = $1',
        [m.from_discord_id]
      );
      const fromName = fromResult.rows[0] ? fromResult.rows[0].username : 'ผู้ใช้ที่ยกเลิกบัญชีแล้ว';
      const preview = m.body.length > 100 ? m.body.slice(0, 100) + '…' : m.body;
      fields.push({ name: `จาก ${fromName}`, value: preview });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📬 กล่องข้อความของ ${user.username}`)
      .setDescription('10 รายการล่าสุด')
      .setColor(0xf97316)
      .addFields(fields);

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Mailbox error:', err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด ลองอีกครั้งนะ');
  }
}

client.login(process.env.DISCORD_TOKEN);
