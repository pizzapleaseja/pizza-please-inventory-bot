// ============================================================
// PIZZA PLEASE — INVENTORY BOT v1
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

async function send(chatId, text) {
  await fetch(`${BASE_URL}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(e => console.error('send error:', e));
}

async function callSheetWriter(payload) {
  const res = await fetch(SHEET_WRITER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...payload, secret: SHEET_SECRET }),
  });
  return res.json();
}

async function loadItems(store) {
  if (itemCache[store]) return itemCache[store];
  const result = await callSheetWriter({ action: 'getItems', store });
  if (!result.ok) throw new Error(result.error || 'Failed to load items');
  itemCache[store] = { ingredients: result.ingredients, drinks: result.drinks };
  return itemCache[store];
}

async function askNextItem(chatId, session) {
  const items = itemCache[session.store];

  if (session.phase === 'ingredients') {
    if (session.itemIndex < items.ingredients.length) {
      const item = items.ingredients[session.itemIndex];
      const n    = session.itemIndex + 1;
      const tot  = items.ingredients.length;
      await send(chatId, `📦 *${item.name}* (${n}/${tot})\nHow many *${item.uom}* do you have?`);
    } else {
      session.phase     = 'drinks';
      session.itemIndex = 0;
      await send(chatId, `✅ *Ingredients done!* Now let's do the drinks. 🥤\n\n${items.drinks.length} items to go.`);
      await askNextItem(chatId, session);
    }
  } else if (session.phase === 'drinks') {
    if (session.itemIndex < items.drinks.length) {
      const item = items.drinks[session.itemIndex];
      const n    = session.itemIndex + 1;
      const tot  = items.drinks.length;
      await send(chatId, `🥤 *${item.name}* (${n}/${tot})\nHow many *${item.uom}* do you have?`);
    } else {
      await finishSubmission(chatId, session);
    }
  }
}

async function handleAnswer(chatId, session, text) {
  const value = parseFloat(text.replace(/,/g, ''));
  if (isNaN(value) || value < 0) {
    await send(chatId, `⚠️ Please enter a number only. Try again:`);
    return;
  }

  const result = await callSheetWriter({
    action:   'writeCount',
    store:    session.store,
    type:     session.phase === 'ingredients' ? 'ingredient' : 'drink',
    rowIndex: session.itemIndex,
    value:    value,
  });

  if (!result.ok) {
    await send(chatId, `⚠️ Error saving count: ${result.error}. Please try again.`);
    return;
  }

  session.itemIndex++;
  sessions[chatId] = session;
  await askNextItem(chatId, session);
}

async function finishSubmission(chatId, session) {
  session.phase    = 'done';
  sessions[chatId] = session;

  const store     = session.store;
  const storeName = STORE_NAMES[store];
  const icon      = STORE_ICONS[store];

  submissions[store] = true;

  await send(chatId, `✅ *${storeName} inventory submitted!*\n\nThank you! All your counts have been recorded. 🙏`);

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
      `${icon} *${storeName}* submitted inventory. ✅\n` +
      `⏳ Still waiting for: *${pending.map(s => STORE_NAMES[s]).join(', ')}*`
    );
  }
}

async function generateSupplierOrders() {
  const result = await callSheetWriter({ action: 'getOrderData' });
  if (!result.ok) {
    await send(OWNER_ID, `⚠️ Failed to read order data: ${result.error}`);
    return;
  }

  const suppliers = result.suppliers;
  const dateStr   = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  let emailCount    = 0;
  let whatsappCount = 0;

  for (const [supplierName, supplier] of Object.entries(suppliers)) {
    const contact  = (supplier.contact  || '').toLowerCase();
    const delivery = (supplier.delivery || '').toLowerCase();
    const messages = buildOrderMessages(supplier, delivery, dateStr);

    for (const msg of messages) {
      const label = msg.label ? ` (${msg.label})` : '';

      if (contact.includes('email') || contact.includes('both')) {
        await callSheetWriter({
          action:  'createEmailDraft',
          subject: `Order Request — ${supplierName}${label} — ${dateStr}`,
          body:    msg.text,
        });
        await send(OWNER_ID, `📧 Email draft created for *${supplierName}*${label}\n_Check pizzapleaseordering@gmail.com drafts_`);
        emailCount++;
      }

      if (contact.includes('whatsapp') || contact.includes('both')) {
        const waMsg = `📋 *Order — ${supplierName}*${label}\n\n${msg.text}`;
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

function buildOrderMessages(supplier, delivery, dateStr) {
  const items  = supplier.items;
  const name   = supplier.name;
  const header = `Pizza Please — Order Request\nSupplier: ${name}\nDate: ${dateStr}\n\n`;

  if (delivery.includes('direct')) {
    let body = header + `Please prepare the following order for direct delivery to each location:\n\n`;
    for (const item of items) {
      body += `${item.name}:\n`;
      if (item.village > 0) body += `  Village Plaza:  ${item.village}\n`;
      if (item.wf      > 0) body += `  Waterfront:     ${item.wf}\n`;
      if (item.lig     > 0) body += `  Liguanea:       ${item.lig}\n`;
      if (item.ochi    > 0) body += `  Ocho Rios:      ${item.ochi}\n`;
      body += '\n';
    }
    body += 'Thank you!';
    return [{ text: body, label: '' }];
  }

  if (delivery.includes('village')) {
    const messages    = [];
    const hasOchi     = items.some(i => i.ochi > 0);
    const hasKingston = items.some(i => (i.village + i.wf + i.lig) > 0);

    if (hasKingston) {
      let body = header + `Please prepare the following consolidated order for delivery to Village Plaza (Kingston stores):\n\n`;
      for (const item of items) {
        const qty = (item.village || 0) + (item.wf || 0) + (item.lig || 0);
        if (qty > 0) body += `${item.name}: ${qty}\n`;
      }
      body += `\nBreakdown by location:\n`;
      for (const item of items) {
        const qty = (item.village || 0) + (item.wf || 0) + (item.lig || 0);
        if (qty > 0) {
          body += `\n${item.name}:\n`;
          if (item.village > 0) body += `  Village Plaza: ${item.village}\n`;
          if (item.wf      > 0) body += `  Waterfront:    ${item.wf}\n`;
          if (item.lig     > 0) body += `  Liguanea:      ${item.lig}\n`;
        }
      }
      body += '\nThank you!';
      messages.push({ text: body, label: 'Kingston' });
    }

    if (hasOchi) {
      let body = header + `Please prepare the following order for delivery to Ocho Rios:\n\n`;
      for (const item of items) {
        if (item.ochi > 0) body += `${item.name}: ${item.ochi}\n`;
      }
      body += '\nThank you!';
      messages.push({ text: body, label: 'Ocho Rios' });
    }

    return messages;
  }

  let body = header;
  for (const item of items) {
    if (item.total > 0) body += `${item.name}: ${item.total}\n`;
  }
  body += '\nThank you!';
  return [{ text: body, label: '' }];
}

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
  let ownerMsg = `📋 Monday inventory prompt sent to ${sent} store(s).`;
  if (missing.length > 0) {
    ownerMsg += `\n⚠️ Could not reach: *${missing.map(s => STORE_NAMES[s]).join(', ')}* — they haven't messaged the bot yet.`;
  }
  await send(OWNER_ID, ownerMsg);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update || !update.update_id) return;
  if (processed.has(update.update_id)) return;
  processed.add(update.update_id);
  if (processed.size > 1000) {
    [...processed].slice(0, 500).forEach(id => processed.delete(id));
  }
  if (update.message) await handleMessage(update.message);
});

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text   = (msg.text || '').trim();
  const store  = getStore(msg.from, chatId);

  if (!store) {
    const username = msg.from && msg.from.username ? '@' + msg.from.username : 'no username';
    const name     = msg.from && msg.from.first_name ? msg.from.first_name : 'Unknown';
    await send(OWNER_ID, `⚠️ *Unauthorised access attempt*\nName: ${name}\nUsername: ${username}\nChat ID: ${chatId}`);
    await send(chatId, `Sorry, you are not authorised to use this bot.`);
    return;
  }

  if (!knownChatIds[store]) {
    knownChatIds[store] = chatId;
    console.log(`Registered chat ID for ${STORE_NAMES[store]}: ${chatId}`);
    await send(OWNER_ID, `📌 *${STORE_NAMES[store]}* registered on the inventory bot.\n_Chat ID: ${chatId}_`);
  }

  const upper = text.toUpperCase();

  if (upper === 'START') {
    if (sessions[chatId] && sessions[chatId].phase === 'done') {
      await send(chatId, `✅ You have already submitted this week.\nType *RESTART* if you need to redo it.`);
      return;
    }
    try {
      await send(chatId, `Loading your item list... ⏳`);
      const items = await loadItems(store);
      sessions[chatId] = { store, phase: 'ingredients', itemIndex: 0 };
      await send(chatId,
        `Let's go! 📋\n\n` +
        `I'll ask you for each item one by one.\n` +
        `📦 *Ingredients:* ${items.ingredients.length} items\n` +
        `🥤 *Drinks:* ${items.drinks.length} items\n\n` +
        `Just type the number when asked.\n` +
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
    const registered = Object.keys(knownChatIds);
    statusMsg += `\n📌 Registered: ${registered.map(s => STORE_NAMES[s]).join(', ') || 'none'}`;
    await send(chatId, statusMsg);
    return;
  }

  if (sessions[chatId] && sessions[chatId].phase !== 'done') {
    await handleAnswer(chatId, sessions[chatId], text);
    return;
  }

  await send(chatId, `Type *START* to begin your inventory submission.`);
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pizza Please Inventory Bot running on port ${PORT}`));
