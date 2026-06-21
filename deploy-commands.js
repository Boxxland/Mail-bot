// deploy-commands.js — สคริปต์ลงทะเบียน Slash Command กับ Discord (Mail Bot)
// รันแค่ครั้งเดียวตอนติดตั้งครั้งแรก หรือทุกครั้งที่แก้ไข/เพิ่มคำสั่งใหม่
// คำสั่ง: node deploy-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('register')
    .setDescription('สมัครบัญชี Mail Bot'),

  new SlashCommandBuilder()
    .setName('mail')
    .setDescription('ส่งข้อความหาผู้ใช้ที่ลงทะเบียน Mail Bot ไว้แล้ว')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('คนที่จะส่งข้อความหา').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('ข้อความที่จะส่ง').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('mailbox')
    .setDescription('ดูข้อความที่เคยได้รับ (10 รายการล่าสุด)'),

  new SlashCommandBuilder()
    .setName('reply')
    .setDescription('ตอบกลับข้อความล่าสุดที่ได้รับ')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('ข้อความที่จะตอบกลับ').setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 กำลังลงทะเบียน Slash Command...');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('✅ ลงทะเบียน Slash Command สำเร็จ!');
  } catch (err) {
    console.error('❌ ลงทะเบียนไม่สำเร็จ:', err);
  }
})();
