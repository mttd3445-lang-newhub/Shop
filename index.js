require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');
const config = require('./config.json');

// Host-friendly overrides: environment variables take precedence over config.json.
config.token = process.env.DISCORD_TOKEN || config.token;
config.keyApiPort = Number(process.env.PORT || process.env.KEY_API_PORT || config.keyApiPort || 8787);
config.keyApiHost = process.env.KEY_API_HOST || config.keyApiHost || '0.0.0.0';
config.keyHubUrl = (process.env.KEYHUB_URL || config.keyHubUrl || 'https://starrejoin993.markxhub883.workers.dev').replace(/\/$/, '');
if (!/^https?:\/\//i.test(config.keyHubUrl)) config.keyHubUrl = 'https://' + config.keyHubUrl;
const KEYHUB_ADMIN_TOKEN = process.env.KEYHUB_ADMIN_TOKEN || '';


const client = new Client({ intents: [GatewayIntentBits.Guilds], partials: [Partials.Channel] });

/* ---------------- ฐานข้อมูลไฟล์ JSON ---------------- */
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
const read = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2));

const getUsers = () => read('users.json', {});
const saveUsers = v => write('users.json', v);
const getProducts = () => read('products.json', []);
const saveProducts = v => write('products.json', v);
const getOrders = () => read('orders.json', []);
const saveOrders = v => write('orders.json', v);

const pending = new Map();


/* ---------------- ระบบคีย์ STAR Plus ----------------
 * Key management is stored in Cloudflare D1 through KeyHub.
 * The admin token exists only on the bot server (environment variable).
 */
const KEY_API_PORT = Number(config.keyApiPort || 8787);
const KEY_API_HOST = config.keyApiHost || '0.0.0.0';
const KEY_PREFIX = 'STAR';

function parseDuration(input) {
  const m = String(input || '').trim().match(/^(\d+)\s*(d|day|days|h|hour|hours)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  return unit.startsWith('h') ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}

function maskKey(k) {
  const s = String(k || '');
  return s.length > 9 ? `${s.slice(0, 9)}••••••••` : s;
}

function normalizeKey(v) {
  return String(v || '').trim().toUpperCase();
}

async function keyHubRequest(method, endpoint, body) {
  if (!KEYHUB_ADMIN_TOKEN) throw new Error('ยังไม่ได้ตั้งค่า KEYHUB_ADMIN_TOKEN บนเครื่อง Bot');
  const url = `${config.keyHubUrl}${endpoint}`;
  const res = await axios({
    method,
    url,
    data: body,
    timeout: 10000,
    validateStatus: () => true,
    headers: {
      Authorization: `Bearer ${KEYHUB_ADMIN_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  let data = res.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch {}
  }
  if (res.status < 200 || res.status >= 300 || !data?.ok) {
    const code = data?.code || `HTTP_${res.status}`;
    const err = new Error(data?.error || data?.message || code);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function keyStatusFromApi(k) {
  if (!k) return 'NOT_FOUND';
  if (k.revoked || k.revoked_at || k.revokedAt) return 'REVOKED';
  if (!(k.activated_at ?? k.activatedAt)) return 'UNUSED';
  const exp = Number(k.expires_at ?? k.expiresAt ?? 0);
  if (exp && Date.now() >= exp) return 'EXPIRED';
  return 'ACTIVE';
}

async function startKeyApi() {
  // The legacy local JSON Key API is intentionally not started.
  // STAR Plus clients should use the Cloudflare Worker directly.
  console.log(`🔑 KeyHub: ${config.keyHubUrl}`);
}

/* ---------------- ฟังก์ชันช่วย ---------------- */
const round2 = n => Math.round(n * 100) / 100;
const baht = n => `฿${Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
const nowTh = () => new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
const oid = () => 'OD' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100);
const isAdmin = i => i.member?.roles.cache.has(config.adminRoleId) || i.member?.permissions.has(PermissionFlagsBits.Administrator);
/* Roblox หัค่าธรรมเนียม 30% จากยอดขายเกมพาส (ผู้ขายได้ 70%) */
const ROBLOX_CUT = 0.7;

function ensureUser(users, id) {
  if (!users[id]) users[id] = { balance: 0, purchases: [], topups: [] };
  users[id].purchases ??= []; users[id].topups ??= [];
  return users[id];
}

async function dm(userId, embeds) {
  try {
    const u = await client.users.fetch(userId);
    const arr = Array.isArray(embeds) ? embeds : [embeds];
    for (let i = 0; i < arr.length; i += 10) await u.send({ embeds: arr.slice(i, i + 10) });
    return true;
  } catch { return false; }
}

function logEmbed(title, o) {
  const ch = client.channels.cache.get(config.logChannelId);
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(title).addFields(
    { name: 'ผู้ใช้', value: o.userId ? `<@${o.userId}>` : '-', inline: true },
    { name: 'รายการ', value: String(o.detail || o.name || '-'), inline: true },
    { name: 'จำนวนเงิน', value: baht(o.amount ?? 0), inline: true },
    { name: 'อ้างอิง', value: String(o.id || o.code || '-'), inline: true }
  ).setTimestamp()] }).catch(() => {});
}

function setOrderStatus(oidStr, status) {
  const orders = getOrders(); const o = orders.find(x => x.id === oidStr);
  if (!o) return null;
  o.status = status; saveOrders(orders);
  const users = getUsers(); const u = users[o.userId];
  if (u) { const p = u.purchases.find(x => x.id === oidStr); if (p) p.status = status; saveUsers(users); }
  return o;
}

function codeDeliverEmbed(name, codes, order, total) {
  const chunks = [];
  let cur = '';
  for (const c of codes) {
    if (cur && (cur.length + c.length + 1) > 900) { chunks.push(cur); cur = ''; }
    cur += c + '\n';
  }
  if (cur) chunks.push(cur);

  const embeds = [];
  for (let i = 0; i < chunks.length; i += 8) {
    const e = new EmbedBuilder().setColor(0x57F287);
    if (i === 0) e.setTitle('📦 สินค้าของคุณ').addFields(
      { name: 'สินค้า', value: `${name} x${codes.length} ชิ้น`, inline: true },
      { name: 'ยอดจ่าย', value: baht(total), inline: true },
      { name: 'อ้างอิง', value: order, inline: true });
    chunks.slice(i, i + 8).forEach((chunk, j) =>
      e.addFields({ name: (i + j) === 0 ? `โค้ด ${codes.length} ชิ้น` : 'โค้ด (ต่อ)', value: '```\n' + chunk + '```' }));
    embeds.push(e);
  }
  return embeds;
}

async function replyCodesFallback(i, header, codes) {
  const text = codes.join('\n');
  if (text.length <= 1800) return i.editReply({ content: `${header}\n\`\`\`\n${text}\n\`\`\`` });
  await i.editReply({ content: header });
  let cur = '```';
  for (const c of codes) {
    if (cur.length + c.length + 5 > 1900) { await i.followUp({ content: cur + '```', ephemeral: true }); cur = '```'; }
    cur += c + '\n';
  }
  if (cur !== '```') await i.followUp({ content: cur + '```', ephemeral: true });
}

/* ---------------- 🚨 ระบบแจ้งเตือนแอดมินอัตโนมัติ ---------------- */
/* ส่ง DM ให้ adminUserId — ถ้าไม่ได้ตั้ง/DM ปิด จะส่ง fallback เข้าห้องล็อก */
async function alertAdmin(embed) {
  if (config.adminUserId) {
    try {
      const u = await client.users.fetch(config.adminUserId);
      await u.send({ embeds: [embed] });
      return;
    } catch { /* DM ปิด → ลองห้องล็อก */ }
  }
  const ch = client.channels.cache.get(config.logChannelId);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

async function getRobuxBalance() {
  const res = await axios.get(`https://economy.roblox.com/v1/users/${config.robloxUserId}/currency`,
    { headers: { cookie: `.ROBLOSECURITY=${config.robloxCookie}` }, validateStatus: () => true });
  if (res.status === 200 && typeof res.data.robux === 'number') return res.data.robux;
  return null; // คุกกี้พัง หรือ API มีปัญหา
}

let robuxAlerted = false;   // กันสแปม: เตือนรอบเดียวจนกว่าจะกลับมาปกติ
let cookieAlerted = false;

async function checkRobux() {
  if (!config.robloxCookie || !config.robloxUserId) return; // โหมดแอดมินยืนยัน ไม่ต้องเช็ค
  const min = config.minRobuxAlert ?? 100;
  const bal = await getRobuxBalance();

  if (bal === null) {
    if (!cookieAlerted) {
      cookieAlerted = true;
      await alertAdmin(new EmbedBuilder().setColor(0xED4245).setTitle('🚨 เช็คบัญชี Roblox ไม่ได้!')
        .setDescription('อ่านยอดโรบัคส์ไม่สำเร็จ — **คุกกี้อาจหมดอายุ/ถูกเตะ session หรือเปลี่ยนรหัสผ่าน**\n' +
          'ออเดอร์เติมโรบัคส์ถัดไปจะล้มเหลวและ**คืนเงินลูกค้าอัตโนมัติ**\n\n' +
          '🔧 วิธีแก้: เอาคุกกี้ใหม่ (F12 → Application → Cookies → `.ROBLOSECURITY`) มาแทนใน config.json แล้วรีสตาร์ทบอท'));
    }
    return;
  }
  cookieAlerted = false;

  if (bal < min) {
    if (!robuxAlerted) {
      robuxAlerted = true;
      await alertAdmin(new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ โรบัคส์บัญชีร้านใกล้หมด!')
        .setDescription(`ยอดปัจจุบัน: **${bal.toLocaleString()} R$** (ต่ำกว่าเกณฑ์ ${min} R$)\n\n` +
          '💸 เติมโรบัคส์เข้าบัญชีร้านด่วน ไม่งั้นออเดอร์ถัดไปจะถูกคืนเงินอัตโนมัติ'));
    }
  } else if (robuxAlerted) {
    robuxAlerted = false;
    await alertAdmin(new EmbedBuilder().setColor(0x57F287).setTitle('✅ โรบัคส์กลับมาปกติ')
      .setDescription(`ยอดปัจจุบัน: **${bal.toLocaleString()} R$**`));
  }
}

async function checkStockAlert(list) {
  const min = config.minStockAlert ?? 5;
  let changed = false;
  for (const p of list) {
    if (p.stock.length <= min && !p.lowAlerted) {
      p.lowAlerted = true; changed = true;
      await alertAdmin(new EmbedBuilder().setColor(0xFEE75C).setTitle('📦 สต๊อกใกล้หมด!')
        .setDescription(`สินค้า **${p.name}** เหลือเพียง **${p.stock.length}** ชิ้น${p.stock.length === 0 ? ' (หมดเชิง! ลูกค้าซื้อไม่ได้แล้ว)' : ''}\n\n🔧 เติมสต๊อก: \`/addstock\``));
    }
  }
  if (changed) saveProducts(list);
}

async function periodicCheck() {
  try { await checkRobux(); } catch (e) { console.error('checkRobux:', e.message); }
  try { await checkStockAlert(getProducts()); } catch (e) { console.error('checkStock:', e.message); }
}

/* ---------------- แผงหน้าร้าน ---------------- */
function shopPanel() {
  const embed = new EmbedBuilder().setColor(0x57F287).setDescription(
    `# ✨ ร้าน${config.shopName} ผ่านบอท\nระบบ ปลอดภัย ใช้งานได้ทันที\n\n` +
    `💳 รองรับการเติมเงินผ่าน **TrueMoney (อั่งเปา)**\n` +
    `_________________________\n\n` +
    `⚡ ส่งของอัตโนมัติ 24/7\n` +
    `🔒 ปลอดภัย ด้วยระบบเติมเงินและส่งของอัตโนมัติ\n\n` +
    `_________________________\n\n` +
    `📥 กดปุ่มด้านล่างเพื่อเริ่มสั่งซื้อได้เลย!`
  ).setFooter({ text: `${config.shopName} © ${new Date().getFullYear()}` });
  if (config.panelImage) embed.setImage(config.panelImage);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_gamepass').setLabel('เติมเกมส์พาส').setEmoji('🎮').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('shop_products').setLabel('เกมส์สินค้า').setEmoji('📦').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('shop_history').setLabel('ประวัติสั่งซื้อ').setEmoji('📄').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('shop_calc').setLabel('คำนวณเกมพาส').setEmoji('🧮').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('shop_credit').setLabel('เครดิต').setEmoji('💰').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('shop_addmoney').setLabel('เติมเงิน').setEmoji('🧧').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('shop_topups').setLabel('ประวัติเติมเงิน').setEmoji('💸').setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function adminOrderEmbed(o) {
  const e = new EmbedBuilder().setColor(0xFEE75C).setTitle(`🧾 คำสั่งซื้อ ${o.id}`)
    .addFields(
      { name: 'ผู้ซื้อ', value: `<@${o.userId}>`, inline: true },
      { name: 'รายการ', value: `${o.name} (${o.robux} R$)`, inline: true },
      { name: 'ยอดรวม', value: baht(o.amount), inline: true },
      { name: 'สถานะ', value: o.status }
    ).setTimestamp();
  if (o.passId) e.addFields({ name: 'ลิงก์เกมพาส', value: `https://www.roblox.com/game-pass/${o.passId}` });
  return e;
}
const orderButtons = id => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`od_deliver:${id}`).setLabel('✅ ส่งของสำเร็จ').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`od_refund:${id}`).setLabel('↩️ คืนเงิน').setStyle(ButtonStyle.Danger)
);

/* ฟอร์มเติมเกมพาส (ใช้ทั้งจากปุ่มหลักและปุ่มในผลคำนวณ) */
const gamepassModal = () => new ModalBuilder().setCustomId('mp_gamepass').setTitle('🎮 เติมเกมส์คิ้ว (โรบัคส์)')
  .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId('link').setLabel('ลิงก์เกมพาส หรือ ไอดีเกมพาส')
    .setPlaceholder('https://www.roblox.com/game-pass/12345678/ชื่อ')
    .setStyle(TextInputStyle.Short).setRequired(true)));

/* ---------------- Roblox / TrueMoney API ---------------- */
function parseGamePassId(input) {
  const m = input.match(/game-pass\/(\d+)/i);
  if (m) return m[1];
  return /^\d{4,}$/.test(input.trim()) ? input.trim() : null;
}

async function buyGamePass(d) {
  const cookie = `.ROBLOSECURITY=${config.robloxCookie}`;
  const bal = await axios.get(`https://economy.roblox.com/v1/users/${config.robloxUserId}/currency`, { headers: { cookie }, validateStatus: () => true });
  if (bal.status !== 200 || bal.data.robux < d.robux) throw new Error('โรบัคส์ในบัญชีบอทไม่พอ');
  const csrf = await axios.post('https://auth.roblox.com/v2/logout', {}, { headers: { cookie }, validateStatus: () => true });
  const token = csrf.headers['x-csrf-token'];
  const buy = await axios.post(`https://economy.roblox.com/v1/purchases/products/${d.productId}`,
    { expectedCurrency: 1, expectedPrice: d.robux, expectedSellerId: d.sellerId },
    { headers: { cookie, 'X-CSRF-TOKEN': token, 'Content-Type': 'application/json' }, validateStatus: () => true });
  if (buy.status !== 200 || !buy.data.purchased) throw new Error(buy.data?.errorMsg || 'Roblox ปฏิเสธการซื้อ');
}

async function redeemVoucher(code, phone) {
  return (await axios.post(`https://gift.truemoney.com/campaign/vouchers/${code}/redeem`,
    { mobile: phone, voucher_code: code },
    { headers: { 'User-Agent': 'okhttp/3.8.1', 'Content-Type': 'application/json' }, validateStatus: () => true })).data;
}
const TM_ERRORS = {
  VOUCHER_NOT_FOUND: 'ไม่พบอั่งเปานี้ (โค้ดไม่ถูกต้อง)',
  VOUCHER_OWNER: 'ห้ามใช้อั่งเปาที่ซื้อจากเบอร์ตัวเอง',
  VOUCHER_EXPIRED: 'อั่งเปาหมดอายุ',
  VOUCHER_ALREADY_REDEEMED: 'อั่งเปานี้ถูกใช้ไปแล้ว',
  VOUCHER_OUT_OF_STOCK: 'อั่งเปาถูกรับหมดแล้ว'
};

/* ---------------- คำสั่ง Slash ---------------- */
const CMDS = [
  { name: 'panel', description: 'ส่งแผงหน้าร้าน (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'channel', description: 'ห้องที่จะโชว์แผง', type: 7 }] },
  { name: 'addproduct', description: 'เพิ่มสินค้า (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'name', description: 'ชื่อสินค้า', type: 3, required: true },
              { name: 'price', description: 'ราคา/ชิ้น (0.1 บาทขึ้นไป)', type: 10, required: true, min_value: 0.1 }] },
  { name: 'addstock', description: 'เพิ่มสต๊อกโค้ด (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'name', description: 'ชื่อสินค้า', type: 3, required: true },
              { name: 'codes', description: 'โค้ด บรรทัดละ 1 ชิ้น', type: 3, required: true }] },
  { name: 'delproduct', description: 'ลบสินค้า (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'name', description: 'ชื่อสินค้า', type: 3, required: true }] },
  { name: 'products', description: 'ดูสินค้าทั้งหมด' },
  { name: 'addcredit', description: 'เพิ่มเครดิตให้สมาชิก (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'user', description: 'สมาชิก', type: 6, required: true },
              { name: 'amount', description: 'จำนวนบาท', type: 10, required: true }] },
  { name: 'setrate', description: 'ตั้งราคา 1 โรบัคส์ = ? บาท (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'rate', description: 'ราคาต่อ 1 R$ (0.1 บาทขึ้นไป)', type: 10, required: true, min_value: 0.1 }] },
  { name: 'genkey', description: 'สร้างคีย์ STAR (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'duration', description: 'อายุ เช่น 30d หรือ 24h', type: 3, required: true }] },
  { name: 'checkkey', description: 'ตรวจสอบสถานะคีย์ (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'key', description: 'คีย์ STAR', type: 3, required: true }] },
  { name: 'revoke', description: 'ยกเลิกคีย์ (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'key', description: 'คีย์ STAR', type: 3, required: true }] },
  { name: 'extendkey', description: 'เพิ่มอายุคีย์ (แอดมิน)', default_member_permissions: '8',
    options: [{ name: 'key', description: 'คีย์ STAR', type: 3, required: true },
              { name: 'duration', description: 'เพิ่มเวลา เช่น 30d หรือ 24h', type: 3, required: true }] }
];

client.once('ready', async () => {
  console.log('✅ บอทออนไลน์:', client.user.tag);
  const g = client.guilds.cache.get(config.guildId);
  if (g) { await g.commands.set(CMDS); console.log('✅ ลงทะเบียน Slash Commands แล้ว'); }
  console.log('✅ ระบบแจ้งเตือนอัตโนมัติทำงาน (เช็คทุก 10 นาที)');
  periodicCheck();
  setInterval(periodicCheck, 10 * 60 * 1000);
});

/* ---------------- จัดการคำสั่ง ---------------- */
async function onCommand(i) {
  switch (i.commandName) {
    case 'panel': {
      const ch = i.options.getChannel('channel') || i.channel;
      await ch.send(shopPanel());
      return i.reply({ content: `✅ ส่งแผงร้านไปที่ ${ch} แล้ว (แผงเก่าต้องลบแล้วส่งใหม่เพื่อให้มีปุ่มใหม่)`, ephemeral: true });
    }
    case 'addproduct': {
      const name = i.options.getString('name').trim();
      const price = i.options.getNumber('price');
      if (price < 0.1) return i.reply({ content: '❌ ราคาต้องตั้งแต่ 0.1 บาทขึ้นไป', ephemeral: true });
      const list = getProducts();
      if (list.some(p => p.name === name)) return i.reply({ content: '❌ มีสินค้าชื่อนี้แล้ว', ephemeral: true });
      list.push({ name, price, stock: [], lowAlerted: false });
      saveProducts(list);
      return i.reply({ content: `✅ เพิ่มสินค้า **${name}** ราคา **${baht(price)}**/ชิ้น แล้ว (ใช้ /addstock เติมของ)`, ephemeral: true });
    }
    case 'addstock': {
      const name = i.options.getString('name').trim();
      const codes = i.options.getString('codes').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const list = getProducts(); const p = list.find(x => x.name === name);
      if (!p) return i.reply({ content: '❌ ไม่พบสินค้านี้', ephemeral: true });
      const wasLow = p.lowAlerted === true;
      p.lowAlerted = false; // เติมแล้ว รีเซ็ตสถานะแจ้งเตือน
      p.stock.push(...codes); saveProducts(list);
      if (wasLow) alertAdmin(new EmbedBuilder().setColor(0x57F287).setTitle('✅ สต๊อกเติมแล้ว')
        .setDescription(`สินค้า **${name}** ถูกเติม ${codes.length} ชิ้น (รวม ${p.stock.length} ชิ้น)`));
      return i.reply({ content: `✅ เพิ่มสต๊อก **${name}** ${codes.length} ชิ้น (รวม ${p.stock.length})`, ephemeral: true });
    }
    case 'delproduct':
      saveProducts(getProducts().filter(p => p.name !== i.options.getString('name').trim()));
      return i.reply({ content: '🗑️ ลบแล้ว', ephemeral: true });
    case 'products': {
      const list = getProducts();
      if (!list.length) return i.reply({ content: 'ยังไม่มีสินค้า', ephemeral: true });
      return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📦 สินค้าในร้าน')
        .setDescription(list.map(p => `**${p.name}** — ${baht(p.price)}/ชิ้น | เหลือ ${p.stock.length} ชิ้น`).join('\n'))] });
    }
    case 'addcredit': {
      const user = i.options.getUser('user');
      const amount = i.options.getNumber('amount');
      const users = getUsers(); const u = ensureUser(users, user.id);
      u.balance = round2(u.balance + amount);
      u.topups.unshift({ code: 'MANUAL', amount, time: nowTh(), method: 'เพิ่มโดยแอดมิน' });
      saveUsers(users);
      return i.reply({ content: `✅ เพิ่ม ${baht(amount)} ให้ ${user.tag} (คงเหลือ ${baht(u.balance)})`, ephemeral: true });
    }
    case 'setrate': {
      config.robuxRate = i.options.getNumber('rate');
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
      return i.reply({ content: `✅ 1 R$ = ${baht(config.robuxRate)}`, ephemeral: true });
    }
    case 'genkey': {
      const durationText = i.options.getString('duration');
      const durationMs = parseDuration(durationText);
      if (!durationMs) return i.reply({ content: '❌ รูปแบบอายุไม่ถูกต้อง เช่น `30d` หรือ `24h`', ephemeral: true });
      try {
        const key = `STAR-${crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0,4)}-${crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0,4)}-${crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0,4)}`;
        const data = await keyHubRequest('POST', '/admin/api/key/create', { key, duration_ms: durationMs, label: `Discord:${i.user.id}` });
        const createdKey = data.key || key;
        if (!createdKey) throw new Error('KeyHub ไม่ได้ส่ง Key กลับมา');
        return i.reply({ content: `🔑 สร้างคีย์สำเร็จ\n~~~\n${createdKey}\n~~~\n⏳ อายุ: **${durationText}**\n🕐 จะเริ่มนับเมื่อถูกใช้ครั้งแรก`, ephemeral: true });
      } catch (e) {
        console.error('genkey:', e);
        return i.reply({ content: `❌ สร้างคีย์ไม่สำเร็จ: ${e.code || e.message}`, ephemeral: true });
      }
    }
    case 'checkkey': {
      const key = normalizeKey(i.options.getString('key'));
      try {
        const data = await keyHubRequest('POST', '/admin/api/key/get', { key });
        const k = data.key || data.item || data;
        const st = data.status || keyStatusFromApi(k);
        const activated = Number(k?.activated_at ?? k?.activatedAt ?? 0);
        const expires = Number(k?.expires_at ?? k?.expiresAt ?? 0);
        const exp = expires ? new Date(expires).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-';
        return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(st === 'ACTIVE' ? 0x57F287 : 0xFEE75C).setTitle('🔑 สถานะคีย์')
          .addFields(
            { name: 'Key', value: maskKey(key) },
            { name: 'สถานะ', value: st, inline: true },
            { name: 'เริ่มนับ', value: activated ? new Date(activated).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : 'ยังไม่ถูกใช้', inline: true },
            { name: 'หมดอายุ', value: exp, inline: true },
            { name: 'เครื่อง', value: k?.machine_id || k?.machineId ? String(k.machine_id || k.machineId).slice(0, 24) + (String(k.machine_id || k.machineId).length > 24 ? '...' : '') : 'ยังไม่ผูกเครื่อง' }
          )] });
      } catch (e) {
        return i.reply({ content: e.code === 'NOT_FOUND' || e.status === 404 ? '❌ ไม่พบคีย์นี้' : `❌ ตรวจสอบไม่สำเร็จ: ${e.code || e.message}`, ephemeral: true });
      }
    }
    case 'revoke': {
      const key = normalizeKey(i.options.getString('key'));
      try {
        await keyHubRequest('POST', '/admin/api/key/action', { key, action: 'revoke' });
        return i.reply({ content: `🛑 ยกเลิกคีย์ ${maskKey(key)} แล้ว`, ephemeral: true });
      } catch (e) {
        return i.reply({ content: e.code === 'NOT_FOUND' || e.status === 404 ? '❌ ไม่พบคีย์นี้' : `❌ ยกเลิกไม่สำเร็จ: ${e.code || e.message}`, ephemeral: true });
      }
    }
    case 'extendkey': {
      const key = normalizeKey(i.options.getString('key'));
      const durationText = i.options.getString('duration');
      const addMs = parseDuration(durationText);
      if (!addMs) return i.reply({ content: '❌ รูปแบบเวลาไม่ถูกต้อง เช่น `30d` หรือ `24h`', ephemeral: true });
      try {
        await keyHubRequest('POST', '/admin/api/key/extend-days', { key, days: addMs / 86400000 });
        return i.reply({ content: `✅ เพิ่มอายุคีย์ ${maskKey(key)} อีก **${durationText}**`, ephemeral: true });
      } catch (e) {
        return i.reply({ content: e.code === 'NOT_FOUND' || e.status === 404 ? '❌ ไม่พบคีย์นี้' : `❌ เพิ่มอายุไม่สำเร็จ: ${e.code || e.message}`, ephemeral: true });
      }
    }

  }
}

/* ---------------- จัดการปุ่ม ---------------- */
async function onButton(i) {
  const id = i.customId, uid = i.user.id;

  if (id === 'shop_gamepass')
    return i.showModal(gamepassModal());

  /* 🧮 ปุ่มคำนวณเกมพาส */
  if (id === 'shop_calc')
    return i.showModal(new ModalBuilder().setCustomId('mp_calc').setTitle('🧮 คำนวณเกมพาส')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('want').setLabel('จำนวนโรบัคส์ที่ต้องการได้สุทธิ')
        .setPlaceholder('เช่น 700 (คือโรบัคส์ที่จะเข้าบัญชีคุณจริง ๆ)')
        .setStyle(TextInputStyle.Short).setRequired(true))));

  /* ปุ่มในผลคำนวณ → เปิดฟอร์มเติมเกมพาสต่อเลย */
  if (id === 'open_gp_modal')
    return i.showModal(gamepassModal());

  if (id === 'shop_products') {
    const list = getProducts().filter(p => p.stock.length > 0);
    if (!list.length) return i.reply({ content: '📦 สินค้าหมดชั่วคราว', ephemeral: true });
    const menu = new StringSelectMenuBuilder().setCustomId('select_product').setPlaceholder('เลือกสินค้าที่ต้องการซื้อ')
      .addOptions(list.slice(0, 25).map(p => ({ label: p.name, description: `${baht(p.price)}/ชิ้น | เหลือ ${p.stock.length} ชิ้น`, value: p.name })));
    return i.reply({ ephemeral: true, components: [new ActionRowBuilder().addComponents(menu)] });
  }

  if (id === 'shop_history') {
    const u = ensureUser(getUsers(), uid);
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('📄 ประวัติสั่งซื้อ')
      .setDescription(u.purchases.slice(0, 10).map(p => `\`${p.id}\` ${p.detail} — **${baht(p.amount)}** (${p.status})`).join('\n') || 'ยังไม่มีประวัติ')] });
  }

  if (id === 'shop_topups') {
    const u = ensureUser(getUsers(), uid);
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('💸 ประวัติเติมเงิน')
      .setDescription(u.topups.slice(0, 10).map(t => `${t.method} — ${baht(t.amount)} (${t.time})`).join('\n') || 'ยังไม่มีประวัติ')] });
  }

  if (id === 'shop_credit') {
    const u = ensureUser(getUsers(), uid);
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('💰 เครดิตของคุณ')
      .setDescription(`ยอดคงเหลือ: **${baht(u.balance)}**`)] });
  }

  if (id === 'shop_addmoney')
    return i.showModal(new ModalBuilder().setCustomId('mp_topup').setTitle('🏧 เติมเงิน TrueMoney อั่งเปา')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('ลิงก์/โค้ดอั่งเปา')
          .setPlaceholder('https://gift.truemoney.com/campaign/?v=xxxxxxxx').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('phone').setLabel('เบอร์ที่ซื้ออั่งเปา')
          .setPlaceholder('0970378354').setStyle(TextInputStyle.Short).setRequired(true))
      ));

  /* --- ยืนยันเกมพาส --- */
  if (id.startsWith('gp_confirm:')) {
    if (id.split(':')[1] !== uid) return i.reply({ content: '❌ ปุ่มนี้ไม่ใช่ของคุณ', ephemeral: true });
    const d = pending.get(`gp_${uid}`);
    if (!d) return i.reply({ content: '⌛ หมดเวลา กดสั่งใหม่อีกครั้ง', ephemeral: true });
    pending.delete(`gp_${uid}`);
    return createGamepassOrder(i, d);
  }
  if (id.startsWith('gp_cancel')) {
    pending.delete(`gp_${uid}`);
    return i.update({ content: '❌ ยกเลิกแล้ว', embeds: [], components: [] }).catch(() => {});
  }

  /* --- ยืนยันสินค้า (รองรับหลายชิ้น) --- */
  if (id.startsWith('pd_confirm:')) {
    if (id.split(':')[1] !== uid) return i.reply({ content: '❌ ปุ่มนี้ไม่ใช่ของคุณ', ephemeral: true });
    const d = pending.get(`pd_${uid}`);
    if (!d) return i.reply({ content: '⌛ หมดเวลา เลือกสินค้าใหม่', ephemeral: true });
    pending.delete(`pd_${uid}`);
    await i.deferReply({ ephemeral: true });
    const list = getProducts(); const p = list.find(x => x.name === d.name);
    if (!p) return i.editReply({ content: '❌ ไม่พบสินค้านี้แล้ว' });
    if (p.stock.length < d.qty) return i.editReply({ content: `❌ สต๊อกไม่พอ (เหลือ ${p.stock.length} ชิ้น) — เงินยังไม่ถูกหัก` });
    const total = round2(p.price * d.qty);
    const users = getUsers(); const u = ensureUser(users, uid);
    if (u.balance < total) return i.editReply({ content: `❌ เครดิตไม่พอ (ต้องการ ${baht(total)}, มี ${baht(u.balance)})` });
    u.balance = round2(u.balance - total);
    const codes = p.stock.splice(0, d.qty);
    const order = oid();
    u.purchases.unshift({ id: order, type: 'product', detail: `${p.name} x${d.qty}`, amount: total, time: nowTh(), status: 'delivered' });
    saveUsers(users); saveProducts(list);
    checkStockAlert(list); // 🚨 เช็คสต๊อกหลังขาย → เตือนแอดมินถ้าใกล้หมด
    const ok = await dm(uid, codeDeliverEmbed(p.name, codes, order, total));
    logEmbed('🛒 ซื้อสินค้า', { id: order, userId: uid, detail: `${p.name} x${d.qty}`, amount: total });
    if (ok) return i.editReply({ content: `✅ จ่าย ${baht(total)} สำเร็จ! ส่งของ **${d.qty} ชิ้น** ทาง DM แล้ว (อ้างอิง \`${order}\`)` });
    return replyCodesFallback(i, `✅ จ่าย ${baht(total)} สำเร็จ! (DM ปิดอยู่) โค้ดของคุณ:`, codes);
  }
  if (id.startsWith('pd_cancel')) {
    pending.delete(`pd_${uid}`);
    return i.update({ content: '❌ ยกเลิกแล้ว', embeds: [], components: [] }).catch(() => {});
  }

  /* --- แอดมินจัดการออเดอร์เกมพาส --- */
  if (id.startsWith('od_deliver:') || id.startsWith('od_refund:')) {
    if (!isAdmin(i)) return i.reply({ content: '❌ เฉพาะแอดมิน', ephemeral: true });
    const [act, order] = i.customId.split(':');
    const o = getOrders().find(x => x.id === order);
    if (!o) return i.reply({ content: '❌ ไม่พบออเดอร์', ephemeral: true });
    if (o.status !== 'pending') return i.reply({ content: `⚠️ จัดการไปแล้ว (${o.status})`, ephemeral: true });
    if (act === 'od_deliver') {
      setOrderStatus(order, 'delivered');
      await dm(o.userId, new EmbedBuilder().setColor(0x57F287).setTitle('✅ เติมโรบัคส์สำเร็จ')
        .setDescription(`ออเดอร์ \`${order}\` ทีมงานซื้อเกมพาสให้คุณแล้ว โรบัคส์กำลังเข้าบัญชี`));
      logEmbed('✅ ส่งของแล้ว', o);
    } else {
      setOrderStatus(order, 'refunded');
      const users = getUsers(); const u = ensureUser(users, o.userId);
      u.balance = round2(u.balance + o.amount); saveUsers(users);
      await dm(o.userId, new EmbedBuilder().setColor(0xED4245).setTitle('↩️ คืนเงินแล้ว')
        .setDescription(`ออเดอร์ \`${order}\` ถูกยกเลิก คืนเครดิต ${baht(o.amount)}`));
      logEmbed('↩️ คืนเงิน', o);
    }
    return i.update({ embeds: [adminOrderEmbed(o)], components: [] });
  }
}

/* ---------------- สร้างออเดอร์เกมพาส ---------------- */
async function createGamepassOrder(i, d) {
  await i.deferReply({ ephemeral: true });
  const users = getUsers(); const u = ensureUser(users, i.user.id);
  if (u.balance < d.total)
    return i.editReply({ content: `❌ เครดิตไม่พอ ต้องการ ${baht(d.total)} มีอยู่ ${baht(u.balance)} — กด 🏧 เติมเงิน` });
  u.balance = round2(u.balance - d.total);
  const order = oid();
  const orderData = { id: order, userId: i.user.id, type: 'gamepass', passId: d.passId, name: d.name, robux: d.robux, amount: d.total, status: 'pending', time: nowTh() };
  u.purchases.unshift({ id: order, type: 'gamepass', detail: `เกมพาส ${d.name} (${d.robux} R$)`, amount: d.total, time: nowTh(), status: 'pending' });
  saveUsers(users);
  const orders = getOrders(); orders.unshift(orderData); saveOrders(orders);

  if (config.robloxCookie && config.robloxUserId) {
    try {
      await buyGamePass(d);
      setOrderStatus(order, 'delivered');
      logEmbed('✅ ส่งโรบัคส์อัตโนมัติ', orderData);
      await dm(i.user.id, new EmbedBuilder().setColor(0x57F287).setTitle('✅ เติมโรบัคส์สำเร็จ')
        .setDescription(`ได้รับ **${Math.floor(d.robux * ROBLOX_CUT).toLocaleString()} R$** (Roblox หัก 30% จาก ${d.robux.toLocaleString()} R$) แล้ว (อ้างอิง \`${order}\`)`));
      return i.editReply({ content: `✅ สำเร็จ! โรบัคส์เข้าบัญชีคุณแล้ว (อ้างอิง \`${order}\`)` });
    } catch (err) {
      setOrderStatus(order, 'refunded');
      const us2 = getUsers(); const uu = ensureUser(us2, i.user.id);
      uu.balance = round2(uu.balance + d.total); saveUsers(us2);
      logEmbed('❌ ซื้อเกมพาสไม่สำเร็จ (คืนเงินแล้ว)', orderData);
      return i.editReply({ content: `❌ ซื้อไม่สำเร็จ (${err.message}) — คืนเครดิต ${baht(d.total)} แล้ว` });
    }
  }

  const ch = client.channels.cache.get(config.orderChannelId);
  if (ch) await ch.send({ embeds: [adminOrderEmbed(orderData)], components: orderButtons(order) });
  await dm(i.user.id, new EmbedBuilder().setColor(0x57F287).setTitle('🧾 ใบเสร็จสั่งซื้อ')
    .setDescription(`เกมพาส **${d.name}** — ${baht(d.total)}\nสถานะ: รอดำเนินการ (อ้างอิง \`${order}\`)`));
  return i.editReply({ content: `✅ สั่งซื้อสำเร็จ! (อ้างอิง \`${order}\`) รอแอดมินดำเนินการส่งโรบัคส์` });
}

/* ---------------- เมนูเลือกสินค้า → ฟอร์มกรอกจำนวน ---------------- */
async function onSelect(i) {
  if (i.customId !== 'select_product') return;
  const p = getProducts().find(x => x.name === i.values[0]);
  if (!p || !p.stock.length) return i.update({ content: '❌ สินค้าหมดแล้ว', embeds: [], components: [] });
  pending.set(`pd_${i.user.id}`, { name: p.name, qty: 1 });
  return i.showModal(new ModalBuilder().setCustomId('mp_buyqty').setTitle(`🛒 สั่งซื้อ: ${p.name}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('qty').setLabel(`จำนวนชิ้นที่จะซื้อ (เหลือ ${p.stock.length} ชิ้น)`)
      .setPlaceholder('เช่น 1 หรือ 5')
      .setStyle(TextInputStyle.Short).setRequired(true))));
}

/* ---------------- ฟอร์มกรอกข้อมูล ---------------- */
async function onModal(i) {
  /* 🧮 คำนวณเกมพาส: กรอกโรบัคส์ที่อยากได้ → บอกว่าต้องตั้งเกมพาสเท่าไหร่ */
  if (i.customId === 'mp_calc') {
    const wantStr = i.fields.getTextInputValue('want').trim();
    if (!/^\d+$/.test(wantStr) || Number(wantStr) < 1)
      return i.reply({ content: '❌ กรอกเป็นตัวเลขจำนวนเต็ม เช่น 700', ephemeral: true });
    const want = Number(wantStr);
    if (want > 1000000) return i.reply({ content: '❌ จำนวนมากเกินไป (สูงสุด 1,000,000 R$)', ephemeral: true });
    const passPrice = Math.ceil(want / ROBLOX_CUT);          // ราคาเกมพาสที่ต้องตั้ง
    const actual = Math.floor(passPrice * ROBLOX_CUT);        // ที่จะได้เข้าบัญชีจริง (≥ want เสมอ)
    const price = round2(passPrice * config.robuxRate);
    const fee = round2(Math.min(price * config.feePercent / 100, config.feeCap));
    const total = round2(price + fee);
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🧮 ผลคำนวณเกมพาส')
      .setDescription(
        `ต้องการได้สุทธิ: **${want.toLocaleString()} R$**\n\n` +
        `➡️ **ตั้งราคาเกมพาสที่ ${passPrice.toLocaleString()} R$**\n` +
        `(ได้รับจริงหลัง Roblox หัก 30%: ~${actual.toLocaleString()} R$)\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `ค่าบริการ: ${baht(price)}\n` +
        `ค่าธรรมเนียมเติมเงิน: ${baht(fee)}\n` +
        `**รวมทั้งหมด: ${baht(total)}**\n\n` +
        `📋 **ขั้นตอนถัดไป**\n` +
        `1️⃣ เข้าเกมของคุณบน Roblox → สร้าง **Gamepass** ตั้งราคา **${passPrice.toLocaleString()} R$**\n` +
        `2️⃣ คัดลอกลิงก์เกมพาส\n` +
        `3️⃣ กดปุ่มด้านล่าง แล้ววางลิงก์เพื่อสั่งซื้อทันที\n\n` +
        `⏳ โรบัคส์จากเกมพาสจะเข้าแบบ Pending ตามระบบ Roblox`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_gp_modal').setLabel('ไปหน้าเติมเกมส์คิ้ว').setEmoji('🎮').setStyle(ButtonStyle.Primary)
      )] });
  }

  /* 🛒 กรอกจำนวนชิ้น → โชว์ยอดรวมรอยืนยัน */
  if (i.customId === 'mp_buyqty') {
    const d = pending.get(`pd_${i.user.id}`);
    if (!d) return i.reply({ content: '⌛ หมดเวลา เลือกสินค้าใหม่', ephemeral: true });
    const qtyStr = i.fields.getTextInputValue('qty').trim();
    if (!/^\d+$/.test(qtyStr) || Number(qtyStr) < 1)
      return i.reply({ content: '❌ กรอกจำนวนเป็นตัวเลขจำนวนเต็ม 1 ขึ้นไป (เช่น 3)', ephemeral: true });
    const qty = Number(qtyStr);
    const p = getProducts().find(x => x.name === d.name);
    if (!p) return i.reply({ content: '❌ ไม่พบสินค้านี้แล้ว', ephemeral: true });
    if (p.stock.length < qty)
      return i.reply({ content: `❌ สต๊อกไม่พอ คุณขอ ${qty} ชิ้น แต่เหลือ ${p.stock.length} ชิ้น`, ephemeral: true });
    const total = round2(p.price * qty);
    const u = ensureUser(getUsers(), i.user.id);
    pending.set(`pd_${i.user.id}`, { name: p.name, qty, total });
    return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🛒 ยืนยันการซื้อ')
      .setDescription(`สินค้า: **${p.name}**\nจำนวน: **${qty} ชิ้น**\nราคา/ชิ้น: ${baht(p.price)}\n**รวมทั้งหมด: ${baht(total)}**\nเครดิตคุณ: ${baht(u.balance)}\n\nกดยืนยัน = หักเครดิตทันที`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pd_confirm:${i.user.id}`).setLabel('✅ ยืนยันซื้อ').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('pd_cancel').setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary)
      )] });
  }

  /* เติมเกมพาส */
  if (i.customId === 'mp_gamepass') {
    const passId = parseGamePassId(i.fields.getTextInputValue('link'));
    if (!passId) return i.reply({ content: '❌ รูปแบบลิงก์ไม่ถูกต้อง', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const res = await axios.get(`https://apis.roblox.com/game-passes/v1/game-passes/${passId}/product-info`, { validateStatus: () => true });
    const info = res.data;
    if (!info || info.PriceInRobux == null) return i.editReply({ content: '❌ หาเกมพาสนี้ไม่เจอ หรือไม่ได้เปิดขาย' });
    const robux = info.PriceInRobux;
    const price = round2(robux * config.robuxRate);
    const fee = round2(Math.min(price * config.feePercent / 100, config.feeCap));
    const total = round2(price + fee);
    pending.set(`gp_${i.user.id}`, { passId, productId: info.ProductId, sellerId: info.SellerId, name: info.Name, robux, price, fee, total });
    const u = ensureUser(getUsers(), i.user.id);
    return i.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🧾 ยืนยันการเติมโรบัคส์')
      .setDescription(`เกมพาส: **${info.Name}**\nราคา: ${baht(price)} (${robux.toLocaleString()} R$)\n` +
        `คุณจะได้รับจริง: ~**${Math.floor(robux * ROBLOX_CUT).toLocaleString()} R$** (Roblox หัก 30%)\n` +
        `ค่าธรรมเนียม: ${baht(fee)}\n**รวม: ${baht(total)}**\nเครดิตคุณ: ${baht(u.balance)}`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gp_confirm:${i.user.id}`).setLabel('✅ ยืนยันสั่งซื้อ').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('gp_cancel').setLabel('ยกเลิก').setStyle(ButtonStyle.Secondary)
      )] });
  }

  /* เติมเงินอั่งเปา */
  if (i.customId === 'mp_topup') {
    let code = i.fields.getTextInputValue('code').trim();
    const m = code.match(/v=([A-Za-z0-9]+)/); if (m) code = m[1];
    const phone = i.fields.getTextInputValue('phone').replace(/\D/g, '');
    if (!/^0\d{9}$/.test(phone)) return i.reply({ content: '❌ เบอร์โทรไม่ถูกต้อง', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const res = await redeemVoucher(code, phone);
    if (res?.status?.code !== 'SUCCESS')
      return i.editReply({ content: `❌ เติมไม่สำเร็จ: ${TM_ERRORS[res?.status?.code] || res?.status?.message || 'ลองใหม่อีกครั้ง'}` });
    const amount = Number(res.data.voucher.amount_baht);
    const users = getUsers(); const u = ensureUser(users, i.user.id);
    u.balance = round2(u.balance + amount);
    u.topups.unshift({ code, amount, time: nowTh(), method: 'TrueMoney' });
    saveUsers(users);
    logEmbed('💵 เติมเงินสำเร็จ', { id: code, userId: i.user.id, amount });
    return i.editReply({ content: `✅ เติมเงิน ${baht(amount)} สำเร็จ! เครดิตคงเหลือ **${baht(u.balance)}**` });
  }
}

/* ---------------- รวมอีเวนต์ ---------------- */
client.on('interactionCreate', async i => {
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isButton()) await onButton(i);
    else if (i.isStringSelectMenu()) await onSelect(i);
    else if (i.isModalSubmit()) await onModal(i);
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ เกิดข้อผิดพลาด: ' + err.message, ephemeral: true };
    if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

if (!config.token || config.token.includes('วางโทเคน')) {
  console.error('⚠️  ไปใส่ token ใน config.json ก่อน!');
  process.exit(1);
}
startKeyApi();
client.login(config.token);
