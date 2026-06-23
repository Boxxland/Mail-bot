// bot.js — Mail Bot
// Slash Commands:
//   /register   — สมัครบัญชี (modal)
//   /mail       — ส่งเมล (options: user, message)
//   /mailbox    — inbox list + ปุ่มเปิดอ่านเมล
//   /reply      — ตอบเมลล่าสุด (modal)
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  EmbedBuilder, ButtonBuilder, ButtonStyle,
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

client.once('clientReady', () => {
  console.log(`✅ Mail Bot online: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'register') return openRegisterModal(interaction);
    if (interaction.commandName === 'mail') return handleMail(interaction);
    if (interaction.commandName === 'mailbox') return handleMailbox(interaction);
    if (interaction.commandName === 'reply') return openReplyModal(interaction, null);
  }

  // Modal submits
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'mailRegisterModal') return handleRegisterSubmit(interaction);
    if (interaction.customId === 'mailReplyModal') return handleReplySubmit(interaction);
    if (interaction.customId.startsWith('replyToModal_')) return handleReplyToSubmit(interaction);
  }

  // Button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('openMail_')) return handleOpenMail(interaction);
    if (interaction.customId.startsWith('replyBtn_')) return handleReplyBtn(interaction);
    if (interaction.customId.startsWith('deleteBtn_')) return handleDeleteBtn(interaction);
    if (interaction.customId.startsWith('mailboxPage_')) return handleMailboxPage(interaction);
  }
});

// ─────────────────────────────────────────
// /register
// ─────────────────────────────────────────
function openRegisterModal(interaction) {
  const modal = new ModalBuilder().setCustomId('mailRegisterModal').setTitle('สมัครบัญชี Mail Bot');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('username').setLabel('Username (a-z, 0-9, _)')
        .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(20).setRequired(true)
    )
  );
  return interaction.showModal(modal);
}

async function handleRegisterSubmit(interaction) {
  const username = interaction.fields.getTextInputValue('username').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return interaction.reply({ content: '⚠️ username ต้องเป็น a-z, 0-9, _ เท่านั้น (3-20 ตัว)', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const byDiscord = await pool.query('SELECT * FROM mailnot_users WHERE discord_id = $1', [interaction.user.id]);
    if (byDiscord.rows.length > 0) return interaction.editReply(`⚠️ ลงทะเบียนแล้วในชื่อ \`${byDiscord.rows[0].username}\``);
    const byName = await pool.query('SELECT discord_id FROM mailnot_users WHERE username = $1', [username]);
    if (byName.rows.length > 0) return interaction.editReply(`⚠️ username \`${username}\` มีคนใช้แล้ว`);
    await pool.query('INSERT INTO mailnot_users (discord_id, username) VALUES ($1, $2)', [interaction.user.id, username]);
    return interaction.editReply(`✅ ลงทะเบียนสำเร็จ! ชื่อ \`${username}\` 📬`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด ลองใหม่');
  }
}

// ─────────────────────────────────────────
// /mail user:@คน message:ข้อความ
// ─────────────────────────────────────────
async function handleMail(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const sender = await getMailUser(interaction.user.id);
    if (!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน — ใช้ `/register` ก่อนนะ');

    const target = interaction.options.getUser('user');
    const body = interaction.options.getString('message');

    if (target.bot) return interaction.editReply('⚠️ ส่งหาบอทไม่ได้');
    if (target.id === interaction.user.id) return interaction.editReply('⚠️ ส่งหาตัวเองทำไมล่ะ 😄');

    const recipient = await getMailUser(target.id);
    if (!recipient) return interaction.editReply(`⚠️ ${target.tag} ยังไม่ได้ลงทะเบียน Mail Bot`);

    await deliverMail(interaction.user.id, target.id, body, sender.username, target, recipient.username);
    return interaction.editReply(`✅ ส่งถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด');
  }
}

// ─────────────────────────────────────────
// /mailbox — inbox list embed + ปุ่มเปิดอ่าน
// ─────────────────────────────────────────
async function handleMailbox(interaction, page = 0, editInteraction = null) {
  const target = editInteraction || interaction;
  if (!editInteraction) await interaction.deferReply({ ephemeral: true });

  try {
    const user = await getMailUser(interaction.user.id);
    if (!user) return target.editReply('⚠️ ยังไม่ได้ลงทะเบียน — ใช้ `/register` ก่อนนะ');

    const PAGE_SIZE = 5;
    const offset = page * PAGE_SIZE;

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM mailnot_messages WHERE to_discord_id = $1',
      [interaction.user.id]
    );
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const inboxResult = await pool.query(
      `SELECT m.id, m.body, m.created_at, mu.username AS from_username
       FROM mailnot_messages m
       LEFT JOIN mailnot_users mu ON mu.discord_id = m.from_discord_id
       WHERE m.to_discord_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [interaction.user.id, PAGE_SIZE, offset]
    );
    const inbox = inboxResult.rows;

    // ─── Sidebar embed (inbox list) ───
    const sidebarEmbed = new EmbedBuilder()
      .setTitle('📬 Mail.gg')
      .setColor(0xf97316)
      .setDescription(`**กล่องข้อความของ \`${user.username}\`**\n──────────────────`);

    if (inbox.length === 0) {
      sidebarEmbed.addFields({ name: '📭 ว่างเปล่า', value: 'ยังไม่มีเมลเลย' });
    } else {
      const listLines = inbox.map((m, i) => {
        const preview = m.body.length > 30 ? m.body.slice(0, 30) + '…' : m.body;
        return `\`${offset + i + 1}.\` 📧 **${m.from_username || '???'}** — ${preview}`;
      }).join('\n');
      sidebarEmbed.addFields({ name: '\u200b', value: listLines });
    }

    sidebarEmbed.setFooter({ text: `หน้า ${page + 1}/${totalPages} · รวม ${total} เมล` });

    // ─── ปุ่มเปิดอ่านแต่ละเมล ───
    const mailBtns = inbox.map((m, i) =>
      new ButtonBuilder()
        .setCustomId(`openMail_${m.id}_${interaction.user.id}_${page}`)
        .setLabel(`เปิดเมล ${offset + i + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📨')
    );

    // ─── ปุ่มเปลี่ยนหน้า ───
    const prevBtn = new ButtonBuilder()
      .setCustomId(`mailboxPage_${interaction.user.id}_${page - 1}`)
      .setLabel('◀ ก่อนหน้า')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`mailboxPage_${interaction.user.id}_${page + 1}`)
      .setLabel('ถัดไป ▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1);

    // จัด rows (Discord จำกัด 5 ปุ่มต่อ row, max 5 rows)
    const components = [];
    // แบ่งปุ่มเมลเป็น rows ละ 5
    for (let i = 0; i < mailBtns.length; i += 5) {
      components.push(new ActionRowBuilder().addComponents(mailBtns.slice(i, i + 5)));
    }
    // row สุดท้าย: ปุ่มเปลี่ยนหน้า
    components.push(new ActionRowBuilder().addComponents(prevBtn, nextBtn));

    return target.editReply({ embeds: [sidebarEmbed], components });
  } catch (err) {
    console.error(err);
    return target.editReply('❌ เกิดข้อผิดพลาด');
  }
}

// ─────────────────────────────────────────
// กดปุ่มเปลี่ยนหน้า mailbox
// ─────────────────────────────────────────
async function handleMailboxPage(interaction) {
  const parts = interaction.customId.split('_');
  const page = parseInt(parts[2]);
  await interaction.deferUpdate();
  return handleMailbox(interaction, page, interaction);
}

// ─────────────────────────────────────────
// กดปุ่มเปิดอ่านเมล → แสดง embed เนื้อหาเมล + ปุ่ม ตอบกลับ/ลบ
// ─────────────────────────────────────────
async function handleOpenMail(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const parts = interaction.customId.split('_'); // openMail_<id>_<userId>_<page>
    const mailId = parseInt(parts[1]);

    const mailResult = await pool.query(
      `SELECT m.*, mu.username AS from_username, mu2.username AS to_username
       FROM mailnot_messages m
       LEFT JOIN mailnot_users mu ON mu.discord_id = m.from_discord_id
       LEFT JOIN mailnot_users mu2 ON mu2.discord_id = m.to_discord_id
       WHERE m.id = $1`,
      [mailId]
    );
    const mail = mailResult.rows[0];
    if (!mail) return interaction.editReply('⚠️ ไม่พบเมลนี้');

    // หา avatar ของผู้ส่ง
    let senderAvatar = '📧';
    try {
      const senderUser = await client.users.fetch(mail.from_discord_id);
      senderAvatar = senderUser.displayAvatarURL({ size: 64 });
    } catch {}

    const date = new Date(mail.created_at).toLocaleString('th-TH');

    // ─── Content embed ───
    const contentEmbed = new EmbedBuilder()
      .setColor(0xf97316)
      .setAuthor({ name: mail.from_username || '???', iconURL: senderAvatar })
      .setTitle('📩 เมลใหม่')
      .setDescription(`${mail.body}`)
      .addFields(
        { name: 'จาก', value: `\`${mail.from_username || '???'}\``, inline: true },
        { name: 'ถึง', value: `\`${mail.to_username || '???'}\``, inline: true },
        { name: 'เวลา', value: date, inline: true },
      )
      .setFooter({ text: 'Mail.gg' });

    // ─── ปุ่ม ตอบกลับ / ลบ ───
    const replyBtn = new ButtonBuilder()
      .setCustomId(`replyBtn_${mail.from_discord_id}_${mailId}`)
      .setLabel('ตอบกลับ')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('↩️');

    const deleteBtn = new ButtonBuilder()
      .setCustomId(`deleteBtn_${mailId}`)
      .setLabel('ลบเมล')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️');

    const row = new ActionRowBuilder().addComponents(replyBtn, deleteBtn);

    return interaction.editReply({ embeds: [contentEmbed], components: [row] });
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด');
  }
}

// ─────────────────────────────────────────
// กดปุ่ม ตอบกลับ → เปิด modal ให้พิมพ์ข้อความ
// ─────────────────────────────────────────
async function handleReplyBtn(interaction) {
  const parts = interaction.customId.split('_'); // replyBtn_<toDiscordId>_<mailId>
  const toDiscordId = parts[1];
  const mailId = parts[2];

  const modal = new ModalBuilder()
    .setCustomId(`replyToModal_${toDiscordId}_${mailId}`)
    .setTitle('ตอบกลับเมล');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('replyBody')
        .setLabel('ข้อความตอบกลับ')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(1)
        .setMaxLength(1000)
        .setRequired(true)
    )
  );
  return interaction.showModal(modal);
}

async function handleReplyToSubmit(interaction) {
  const parts = interaction.customId.split('_'); // replyToModal_<toDiscordId>_<mailId>
  const toDiscordId = parts[1];
  const body = interaction.fields.getTextInputValue('replyBody');

  await interaction.deferReply({ ephemeral: true });
  try {
    const sender = await getMailUser(interaction.user.id);
    if (!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน');

    const recipient = await getMailUser(toDiscordId);
    if (!recipient) return interaction.editReply('⚠️ คนที่รับยกเลิกบัญชีไปแล้ว');

    const targetUser = await client.users.fetch(toDiscordId).catch(() => null);
    if (!targetUser) return interaction.editReply('⚠️ หาผู้รับไม่เจอ');

    await deliverMail(interaction.user.id, toDiscordId, body, sender.username, targetUser, recipient.username);
    return interaction.editReply(`✅ ตอบกลับถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด');
  }
}

// ─────────────────────────────────────────
// กดปุ่ม ลบเมล
// ─────────────────────────────────────────
async function handleDeleteBtn(interaction) {
  await interaction.deferUpdate();
  try {
    const mailId = parseInt(interaction.customId.split('_')[1]);
    // เช็คว่าเป็นเจ้าของเมลจริงก่อนลบ
    await pool.query(
      'DELETE FROM mailnot_messages WHERE id = $1 AND to_discord_id = $2',
      [mailId, interaction.user.id]
    );
    return interaction.editReply({ content: '🗑️ ลบเมลเรียบร้อยแล้ว', embeds: [], components: [] });
  } catch (err) {
    console.error(err);
    return interaction.followUp({ content: '❌ เกิดข้อผิดพลาด', ephemeral: true });
  }
}

// ─────────────────────────────────────────
// /reply (slash command — ตอบเมลล่าสุด)
// ─────────────────────────────────────────
function openReplyModal(interaction) {
  const modal = new ModalBuilder().setCustomId('mailReplyModal').setTitle('ตอบกลับเมลล่าสุด');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('replyBody').setLabel('ข้อความตอบกลับ')
        .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1000).setRequired(true)
    )
  );
  return interaction.showModal(modal);
}

async function handleReplySubmit(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const sender = await getMailUser(interaction.user.id);
    if (!sender) return interaction.editReply('⚠️ ยังไม่ได้ลงทะเบียน');

    const body = interaction.fields.getTextInputValue('replyBody');
    const lastMsg = await pool.query(
      'SELECT * FROM mailnot_messages WHERE to_discord_id = $1 ORDER BY created_at DESC LIMIT 1',
      [interaction.user.id]
    );
    if (!lastMsg.rows[0]) return interaction.editReply('⚠️ ไม่มีเมลที่จะตอบกลับ');

    const toDiscordId = lastMsg.rows[0].from_discord_id;
    const recipient = await getMailUser(toDiscordId);
    if (!recipient) return interaction.editReply('⚠️ คนที่รับยกเลิกบัญชีไปแล้ว');

    const targetUser = await client.users.fetch(toDiscordId).catch(() => null);
    if (!targetUser) return interaction.editReply('⚠️ หาผู้รับไม่เจอ');

    await deliverMail(interaction.user.id, toDiscordId, body, sender.username, targetUser, recipient.username);
    return interaction.editReply(`✅ ตอบกลับถึง \`${recipient.username}\` แล้ว 📨`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ เกิดข้อผิดพลาด');
  }
}

// ─────────────────────────────────────────
// helper: ส่งเมลจริง (บันทึก DB + DM)
// ─────────────────────────────────────────
async function deliverMail(fromId, toId, body, fromUsername, targetUser, toUsername) {
  await targetUser.send(
    `📩 **เมลใหม่จาก \`${fromUsername}\`** (Mail Bot)\n\n${body}\n\n— ตอบกลับด้วย \`/reply\` หรือดูใน \`/mailbox\``
  );
  await pool.query(
    'INSERT INTO mailnot_messages (from_discord_id, to_discord_id, body) VALUES ($1, $2, $3)',
    [fromId, toId, body]
  );
}

// ─────────────────────────────────────────
// helper: ดึง mail user จาก discord_id
// ─────────────────────────────────────────
async function getMailUser(discordId) {
  const r = await pool.query('SELECT * FROM mailnot_users WHERE discord_id = $1', [discordId]);
  return r.rows[0] || null;
}

client.login(process.env.DISCORD_TOKEN);
