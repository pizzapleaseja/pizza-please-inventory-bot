// ============================================================
// PIZZA PLEASE — INVENTORY BOT v1.6
// Full supplier details from Suppliers tab
// ============================================================
const express = require('express');
const fetch   = require('node-fetch');

const app = express();
app.use(express.json());

const BOT_TOKEN        = process.env.BOT_TOKEN;
const SHEET_WRITER_URL = process.env.SHEET_WRITER_URL;
const SHEET_SECRET     = process.env.SHEET_SECRET || 'PizzaInventory2026$';
const OWNER_ID         = process.env.OWNER_CHAT_ID || '5766630052';
const BASE_URL         = `https://api.telegram.org/bot${BOT_TOKEN}`;

const STAFF = {
  'pizzapleasevillage':    'village',
  'pizzapleasewaterfront': 'waterfront',
  'pizzapleaseliguanea':   'liguanea',
  'pizzapleaseochorios':   'ochorios',
};

const STORE_NAMES = {
  village:    'Village Plaza',
  waterfront: 'Waterfront',
  liguanea:   'Liguanea',
  ochorios:   'Ocho Rios',
};

const STORE_ICONS = {
  village:    '🔵',
  waterfront: '🟢',
  liguanea:   '🟡',
  ochorios:   '🔴',
};

const knownChatIds = {};
const sessions     = {};
const submissions  = {};
const itemCache    = {};
const processed    = new Set();
let weekComplete   = false;

// ── Per-chat message queue ────────────────────────────────────
const queues     = {};
const processing = {};

async function enqueue(chatId, msg, type) {
  if (!queues[chatId]) queues[chatId] = [];
  queues[chatId].push({ msg, type });
  if (!processing[chatId]) await drainQueue(chatId);
}

async function drainQueue(chatId) {
  if (processing[chatId]) return;
  processing[chatId] = true;
  while (queues[chatId] && queues[chatId].length > 0) {
    const { msg, type } = queues[chatId].shift();
    try {
      if (type === 'message')  await handleMessage(msg);
      if (type === 'callback') await handleCallback(msg);
    } catch (e) {
      console.error('Queue error:', e);
    }
  }
  processing[chatId] = false;
}

// ── Helpers ───────────────────────────────────────────────────
function getStore(from, chatId) {
  chatId = String(chatId);
  if (chatId === OWNER_ID) return 'village';
  const username = from && from.username ? from.username.toLowerCase() : null;
  if (username && STAFF[username]) return STAFF[username];
  return null;
}

function todayJA() {
  const d = new Date(Date.now() - 5 * 3600000);
  return d.toISOString().slice(0, 10);
}

function pendingStores() {
  return Object.keys(STORE_NAMES).filter(s => !submissions[s]);
}

// ── Telegram API ──────────────────────────────────────────────
async function send(chatId, text) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(e => console.error('send error:', e));
}

async function sendKb(chatId, text, keyboard) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:      chatId,
      text,
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    }),
  }).catch(e => console.error('sendKb error:', e));
}

async function answerCb(queryId) {
  await fetch(`${BASE_URL}/answerCallbackQuery`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: queryId }),
  }).catch(() => {});
}

async function callSheetWriter(payload) {
  const res = await fetch(SHEET_WRITER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...payload, secret: SHEET_SECRET }),
  });
  return res.json();
}

// ── Load items ────────────────────────────────────────────────
async function loadItems(store) {
  if (itemCache[store]) return itemCache[store];
  const result = await callSheetWriter({ action: 'getItems', store });
  if (!result.ok) throw new Error(result.error || 'Failed to load items');
  itemCache[store] = { ingredients: result.ingredients, drinks: result.drinks };
  return itemCache[store];
}

// ── Ask next item ─────────────────────────────────────────────
async function askNextItem(chatId, session) {
  const items = itemCache[session.store];
  if (session.phase === 'ingredients') {
    if (session.itemIndex < items.ingredients.length) {
      const item = items.ingredients[session.itemIndex];
      const n    = session.itemIndex + 1;
      const tot  = items.ingredients.length;
      await send(chatId, `📦 *${item.name}* (${n}/${tot})\nHow many *${item.uom}* do you have?`);
    } else {
      await showReview(chatId, session, 'ingredients');
    }
  } else if (session.phase === 'drinks') {
    if (session.itemIndex < items.drinks.length) {
      const item = items.drinks[session.itemIndex];
      const n    = session.itemIndex + 1;
      const tot  = items.drinks.length;
      await send(chatId, `🥤 *${item.name}* (${n}/${tot})\nHow many *${item.uom}* do you have?`);
    } else {
      await showReview(chatId, session, 'drinks');
    }
  }
}

// ── Show review screen ────────────────────────────────────────
async function showReview(chatId, session, type) {
  session.phase    = type === 'ingredients' ? 'review_ingredients' : 'review_drinks';
  session.editing  = null;
  sessions[chatId] = session;

  const items   = type === 'ingredients'
    ? itemCache[session.store].ingredients
    : itemCache[session.store].drinks;
  const answers = type === 'ingredients'
    ? session.answers.ingredients
    : session.answers.drinks;

  const emoji = type === 'ingredients' ? '📦' : '🥤';
  const label = type === 'ingredients' ? 'Ingredients' : 'Drinks';

  let msg = `${emoji} *${label} Review — ${STORE_NAMES[session.store]}*\n`;
  msg    += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  for (let i = 0; i < items.length; i++) {
    const val = answers[i] !== undefined ? answers[i] : '—';
    msg += `*${i + 1}.* ${items[i].name}: *${val}* ${items[i].uom}\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `To edit an item, type its *number* (e.g. type *3* to edit item 3).\n`;
  msg += type === 'ingredients'
    ? `When ready, tap ✅ *Confirm* to proceed to drinks.`
    : `When ready, tap ✅ *Confirm* to submit your inventory.`;

  await sendKb(chatId, msg, [
    [{ text: `✅ Confirm ${label}`, callback_data: `CONFIRM_${type.toUpperCase()}` }]
  ]);
}

// ── Handle answer ─────────────────────────────────────────────
async function handleAnswer(chatId, session, text) {
  const value = parseFloat(text.replace(/,/g, ''));
  if (isNaN(value) || value < 0) {
    await send(chatId, `⚠️ Please enter a number only. Try again:`);
    return;
  }

  const type         = session.phase;
  const indexToWrite = session.itemIndex;

  const result = await callSheetWriter({
    action:   'writeCount',
    store:    session.store,
    type:     type === 'ingredients' ? 'ingredient' : 'drink',
    rowIndex: indexToWrite,
    value:    value,
  });

  if (!result.ok) {
    await send(chatId, `⚠️ Error saving count: ${result.error}. Please try again.`);
    return;
  }

  if (type === 'ingredients') {
    session.answers.ingredients[indexToWrite] = value;
  } else {
    session.answers.drinks[indexToWrite] = value;
  }

  session.itemIndex++;
  sessions[chatId] = session;
  await askNextItem(chatId, session);
}

// ── Handle review edit ────────────────────────────────────────
async function handleReviewEdit(chatId, session, text) {
  const type  = session.phase === 'review_ingredients' ? 'ingredients' : 'drinks';
  const items = type === 'ingredients'
    ? itemCache[session.store].ingredients
    : itemCache[session.store].drinks;

  if (session.editing !== null) {
    const value = parseFloat(text.replace(/,/g, ''));
    if (isNaN(value) || value < 0) {
      await send(chatId, `⚠️ Please enter a valid number for *${items[session.editing].name}*:`);
      return;
    }
    const editIndex = session.editing;
    const result    = await callSheetWriter({
      action:   'writeCount',
      store:    session.store,
      type:     type === 'ingredients' ? 'ingredient' : 'drink',
      rowIndex: editIndex,
      value:    value,
    });
    if (!result.ok) {
      await send(chatId, `⚠️ Error saving: ${result.error}. Try again.`);
      return;
    }
    if (type === 'ingredients') {
      session.answers.ingredients[editIndex] = value;
    } else {
      session.answers.drinks[editIndex] = value;
    }
    session.editing  = null;
    sessions[chatId] = session;
    await send(chatId, `✅ *${items[editIndex].name}* updated to *${value}*`);
    await showReview(chatId, session, type);
    return;
  }

  const num = parseInt(text);
  if (isNaN(num) || num < 1 || num > items.length) {
    await send(chatId,
      `⚠️ Please enter a number between *1* and *${items.length}* to select an item.\nOr tap ✅ Confirm to proceed.`
    );
    return;
  }

  session.editing  = num - 1;
  sessions[chatId] = session;
  const answers    = type === 'ingredients' ? session.answers.ingredients : session.answers.drinks;
  await send(chatId,
    `✏️ Editing *${items[num - 1].name}*\n` +
    `Current value: *${answers[num - 1] !== undefined ? answers[num - 1] : '—'}* ${items[num - 1].uom}\n\n` +
    `Enter the correct number:`
  );
}

// ── Finish submission ─────────────────────────────────────────
async function finishSubmission(chatId, session) {
  session.phase    = 'done';
  sessions[chatId] = session;

  const store     = session.store;
  const storeName = STORE_NAMES[store];
  const icon      = STORE_ICONS[store];
  submissions[store] = true;

  await send(chatId,
    `✅ *${storeName} inventory submitted!*\n\nThank you! All your counts have been recorded. 🙏`
  );

  const pending = pendingStores();
  if (pending.length === 0 && !weekComplete) {
    weekComplete = true;
    await send(OWNER_ID,
      `${icon} *${storeName}* submitted. ✅\n\n` +
      `🎉 *All 4 stores have submitted their inventory!*\n` +
      `Generating supplier orders now...`
    );
    await generateSupplierOrders();
  } else {
    await send(OWNER_ID,
      `${icon} *${storeName}* submitted. ✅\n` +
      `⏳ Still waiting for: *${pending.map(s => STORE_NAMES[s]).join(', ')}*`
    );
  }
}

// ── Generate supplier orders ──────────────────────────────────
async function generateSupplierOrders() {
  const result = await callSheetWriter({ action: 'getOrderData' });
  if (!result.ok) {
    await send(OWNER_ID, `⚠️ Failed to read order data: ${result.error}`);
    return;
  }

  const suppliers = result.suppliers;

  if (!suppliers || Object.keys(suppliers).length === 0) {
    await send(OWNER_ID,
      `⚠️ No orders found in ORD TOT tab.\n` +
      `Please check that order quantities are filled in columns B–E.`
    );
    return;
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  let emailCount    = 0;
  let whatsappCount = 0;

  for (const [supplierName, supplier] of Object.entries(suppliers)) {
    const contact  = (supplier.contactMethod || '').toLowerCase();
    const delivery = (supplier.delivery      || '').toLowerCase();
    const messages = buildOrderMessages(supplier, delivery, dateStr);

    for (const msg of messages) {
      const label = msg.label ? ` (${msg.label})` : '';

      // ── EMAIL ──
      if (contact.includes('email')) {
        await callSheetWriter({
          action:  'createEmailDraft',
          to:      supplier.email || '',
          subject: `Order Request — ${supplierName}${label} — ${dateStr}`,
          body:    msg.text,
        });
        await send(OWNER_ID,
          `📧 Email draft created for *${supplierName}*${label}\n` +
          `_To: ${supplier.email || 'no email on file'}_\n` +
          `_Check pizzapleaseordering@gmail.com drafts_`
        );
        emailCount++;
      }

      // ── WHATSAPP ──
      if (contact.includes('whatsapp')) {
        const waHeader =
          `📋 *Order — ${supplierName}*${label}\n` +
          (supplier.contactName ? `_Attn: ${supplier.contactName}_\n` : '') +
          (supplier.whatsapp    ? `_WhatsApp: ${supplier.whatsapp}_\n` : '') +
          (supplier.deliveryDay ? `_Delivery day: ${supplier.deliveryDay}_\n` : '') +
          `\n`;
        const waMsg = waHeader + msg.text;
        const villageChatId = knownChatIds['village'];
        if (villageChatId) await send(villageChatId, waMsg);
        await send(OWNER_ID, waMsg);
        whatsappCount++;
      }
    }
  }

  await send(OWNER_ID,
    `✅ *All supplier orders generated!*\n\n` +
    `📧 ${emailCount} email draft(s) → pizzapleaseordering@gmail.com\n` +
    `💬 ${whatsappCount} WhatsApp message(s) sent above for copy/paste`
  );
}

// ── Build order messages ──────────────────────────────────────
function buildOrderMessages(supplier, delivery, dateStr) {
  const items  = supplier.items;
  const name   = supplier.name;
  const header =
    `Pizza Please — Order Request\n` +
    `Supplier: ${name}\n` +
    `Date: ${dateStr}\n\n`;

  // DIRECT TO ALL STORES — each store gets its own delivery
  if (delivery.includes('direct')) {
    let body = header + `Please prepare the following order for delivery to each location:\n\n`;

    // Village
    const villageItems = items.filter(i => i.village);
    if (villageItems.length > 0 && supplier.addrVillage) {
      body += `📍 *Village Plaza*\n${supplier.addrVillage}\n`;
      villageItems.forEach(i => { body += `  ${i.name}: ${i.village}\n`; });
      body += '\n';
    }

    // Waterfront
    const wfItems = items.filter(i => i.wf);
    if (wfItems.length > 0 && supplier.addrWaterfront) {
      body += `📍 *Waterfront*\n${supplier.addrWaterfront}\n`;
      wfItems.forEach(i => { body += `  ${i.name}: ${i.wf}\n`; });
      body += '\n';
    }

    // Liguanea
    const ligItems = items.filter(i => i.lig);
    if (ligItems.length > 0 && supplier.addrLiguanea) {
      body += `📍 *Liguanea*\n${supplier.addrLiguanea}\n`;
      ligItems.forEach(i => { body += `  ${i.name}: ${i.lig}\n`; });
      body += '\n';
    }

    // Ocho Rios
    const ochiItems = items.filter(i => i.ochi);
    if (ochiItems.length > 0 && supplier.addrOchoRios) {
      body += `📍 *Ocho Rios*\n${supplier.addrOchoRios}\n`;
      ochiItems.forEach(i => { body += `  ${i.name}: ${i.ochi}\n`; });
      body += '\n';
    }

    body += 'Thank you!';
    return [{ text: body, label: '' }];
  }

  // VILLAGE DELIVERY MODEL — Kingston consolidated + separate Ocho Rios
  const messages    = [];
  const kingstonItems = items.filter(i => i.village || i.wf || i.lig);
  const ochiItems2    = items.filter(i => i.ochi);

  if (kingstonItems.length > 0) {
    let body = header +
      `Please prepare the following order for delivery to Village Plaza (for Kingston stores):\n` +
      (supplier.addrVillage ? `📍 ${supplier.addrVillage}\n` : '') + '\n';

    kingstonItems.forEach(i => {
      body += `${i.name}:\n`;
      if (i.village) body += `  Village Plaza: ${i.village}\n`;
      if (i.wf)      body += `  Waterfront:    ${i.wf}\n`;
      if (i.lig)     body += `  Liguanea:      ${i.lig}\n`;
      body += '\n';
    });
    body += 'Thank you!';
    messages.push({ text: body, label: 'Kingston' });
  }

  if (ochiItems2.length > 0) {
    let body = header +
      `Please prepare the following order for delivery to Ocho Rios:\n` +
      (supplier.addrOchoRios ? `📍 ${supplier.addrOchoRios}\n` : '') + '\n';

    ochiItems2.forEach(i => { body += `${i.name}: ${i.ochi}\n`; });
    body += '\nThank you!';
    messages.push({ text: body, label: 'Ocho Rios' });
  }

  if (messages.length === 0) {
    // Fallback — just list everything
    let body = header;
    items.forEach(i => {
      body += `${i.name}:\n`;
      if (i.village) body += `  Village Plaza: ${i.village}\n`;
      if (i.wf)      body += `  Waterfront:    ${i.wf}\n`;
      if (i.lig)     body += `  Liguanea:      ${i.lig}\n`;
      if (i.ochi)    body += `  Ocho Rios:     ${i.ochi}\n`;
      body += '\n';
    });
    body += 'Thank you!';
    messages.push({ text: body, label: '' });
  }

  return messages;
}

// ── Monday prompt ─────────────────────────────────────────────
async function sendMondayPrompt() {
  weekComplete = false;
  Object.keys(submissions).forEach(k => delete submissions[k]);
  Object.keys(sessions).forEach(k   => delete sessions[k]);
  Object.keys(itemCache).forEach(k  => delete itemCache[k]);

  let sent = 0;
  for (const [store, chatId] of Object.entries(knownChatIds)) {
    await send(chatId,
      `🍕 *Good morning ${STORE_NAMES[store]}!*\n\n` +
      `It's Monday — time to submit your weekly inventory count.\n\n` +
      `Type *START* when you're ready to begin.`
    );
    sent++;
  }

  const missing = Object.keys(STORE_NAMES).filter(s => !knownChatIds[s]);
  let ownerMsg  = `📋 Monday inventory prompt sent to ${sent} store(s).`;
  if (missing.length > 0) {
    ownerMsg += `\n⚠️ Could not reach: *${missing.map(s => STORE_NAMES[s]).join(', ')}*`;
  }
  await send(OWNER_ID, ownerMsg);
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update || !update.update_id) return;
  if (processed.has(update.update_id)) return;
  processed.add(update.update_id);
  if (processed.size > 1000) {
    [...processed].slice(0, 500).forEach(id => processed.delete(id));
  }
  if (update.message) {
    const chatId = String(update.message.chat.id);
    await enqueue(chatId, update.message, 'message');
  }
  if (update.callback_query) {
    const chatId = String(update.callback_query.message.chat.id);
    await enqueue(chatId, update.callback_query, 'callback');
  }
});

// ── Message handler ───────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text   = (msg.text || '').trim();
  const store  = getStore(msg.from, chatId);

  if (!store) {
    const username = msg.from && msg.from.username ? '@' + msg.from.username : 'no username';
    const name     = msg.from && msg.from.first_name ? msg.from.first_name : 'Unknown';
    await send(OWNER_ID,
      `⚠️ *Unauthorised access attempt*\nName: ${name}\nUsername: ${username}\nChat ID: ${chatId}`
    );
    await send(chatId, `Sorry, you are not authorised to use this bot.`);
    return;
  }

  if (!knownChatIds[store]) {
    knownChatIds[store] = chatId;
    console.log(`Registered ${STORE_NAMES[store]}: ${chatId}`);
    await send(OWNER_ID,
      `📌 *${STORE_NAMES[store]}* registered on the inventory bot.\n_Chat ID: ${chatId}_`
    );
  }

  const upper = text.toUpperCase();

  if (upper === 'START') {
    if (sessions[chatId] && sessions[chatId].phase === 'done') {
      await send(chatId, `✅ Already submitted this week. Type *RESTART* to redo.`);
      return;
    }
    try {
      await send(chatId, `Loading your item list... ⏳`);
      const items = await loadItems(store);
      sessions[chatId] = {
        store,
        phase:     'ingredients',
        itemIndex: 0,
        editing:   null,
        answers:   { ingredients: [], drinks: [] },
      };
      await send(chatId,
        `Let's go! 📋\n\n` +
        `I'll ask you for each item one by one.\n` +
        `📦 *Ingredients:* ${items.ingredients.length} items\n` +
        `🥤 *Drinks:* ${items.drinks.length} items\n\n` +
        `⚠️ *Important:* Wait for each question to appear before typing your answer. Send one number at a time only.\n\n` +
        `You'll get a review screen after each section to check and correct your answers.\n\n` +
        `_(Type *RESTART* at any time to start over)_\n\nStarting now!`
      );
      await askNextItem(chatId, sessions[chatId]);
    } catch (err) {
      await send(chatId, `⚠️ Error loading items. Please contact Pietro.\n_${err.message}_`);
      await send(OWNER_ID, `🔴 Error loading items for ${STORE_NAMES[store]}: ${err.message}`);
    }
    return;
  }

  if (upper === 'RESTART') {
    delete sessions[chatId];
    delete submissions[store];
    await send(chatId, `🔄 Session reset. Type *START* to begin again.`);
    return;
  }

  if (upper === '/STATUS' && chatId === OWNER_ID) {
    let statusMsg = `📊 *Inventory Status — ${todayJA()}*\n\n`;
    Object.keys(STORE_NAMES).forEach(s => {
      statusMsg += (submissions[s] ? '✅' : '⏳') + ' ' + STORE_NAMES[s] + '\n';
    });
    statusMsg += `\n📌 Registered: ${Object.keys(knownChatIds).map(s => STORE_NAMES[s]).join(', ') || 'none'}`;
    await send(chatId, statusMsg);
    return;
  }

  const session = sessions[chatId];
  if (!session || session.phase === 'done') {
    await send(chatId, `Type *START* to begin your inventory submission.`);
    return;
  }

  if (session.phase === 'ingredients' || session.phase === 'drinks') {
    await handleAnswer(chatId, session, text);
  } else if (session.phase === 'review_ingredients' || session.phase === 'review_drinks') {
    await handleReviewEdit(chatId, session, text);
  }
}

// ── Callback handler ──────────────────────────────────────────
async function handleCallback(query) {
  const chatId = String(query.message.chat.id);
  const data   = query.data;
  const store  = getStore(query.from, chatId);

  await answerCb(query.id);
  if (!store) return;

  const session = sessions[chatId];
  if (!session) return;

  if (data === 'CONFIRM_INGREDIENTS') {
    session.phase     = 'drinks';
    session.itemIndex = 0;
    sessions[chatId]  = session;
    await send(chatId,
      `✅ *Ingredients confirmed!* Now let's do the drinks. 🥤\n\n` +
      `${itemCache[session.store].drinks.length} items to go.\n\n` +
      `⚠️ *Remember:* Wait for each question before typing your answer.`
    );
    await askNextItem(chatId, session);
    return;
  }

  if (data === 'CONFIRM_DRINKS') {
    await finishSubmission(chatId, session);
    return;
  }
}

// ── Utility endpoints ─────────────────────────────────────────
app.get('/', (req, res) => res.send('Pizza Please Inventory Bot — running ✅'));

app.get('/prompt', async (req, res) => {
  if (req.query.secret !== SHEET_SECRET) return res.status(403).send('Unauthorised');
  await sendMondayPrompt();
  res.json({ ok: true, message: 'Monday prompt sent' });
});

app.get('/reset', (req, res) => {
  if (req.query.secret !== SHEET_SECRET) return res.status(403).send('Unauthorised');
  Object.keys(submissions).forEach(k => delete submissions[k]);
  Object.keys(sessions).forEach(k   => delete sessions[k]);
  Object.keys(itemCache).forEach(k  => delete itemCache[k]);
  weekComplete = false;
  res.send('Reset complete. knownChatIds preserved.');
});

app.get('/simulate-all-done', async (req, res) => {
  if (req.query.secret !== SHEET_SECRET) return res.status(403).send('Unauthorised');
  Object.keys(STORE_NAMES).forEach(s => submissions[s] = true);
  weekComplete = true;
  res.json({ ok: true, message: 'Simulating all stores done — generating supplier orders...' });
  await send(OWNER_ID, `🧪 *[TEST] Simulating all 4 stores submitted.*\nGenerating supplier orders now...`);
  await generateSupplierOrders();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pizza Please Inventory Bot running on port ${PORT}`));
