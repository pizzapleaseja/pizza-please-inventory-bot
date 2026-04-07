// ============================================================
// PIZZA PLEASE — INVENTORY BOT v1.2
// With ingredient + drink review screens before final submit
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
      // All ingredients entered — show review screen
      await showReview(chatId, session, 'ingredients');
    }
  } else if (session.phase === 'drinks') {
    if (session.itemIndex < items.drinks.length) {
      const item = items.drinks[session.itemIndex];
      const n    = session.itemIndex + 1;
      const tot  = items.drinks.length;
      await send(chatId, `🥤 *${item.name}* (${n}/${tot})\nHow many *${item.uom}* do you have?`);
    } else {
      // All drinks entered — show review screen
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
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const val  = answers[i] !== undefined ? answers[i] : '—';
    msg += `*${i + 1}.* ${item.name}: *${val}* ${item.uom}\n`;
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

  if (session.writing) return; // Silent ignore if still writing

  const indexBeforeWrite = session.itemIndex;
  session.writing        = true;
  sessions[chatId]       = session;

  try {
    const type   = session.phase; // 'ingredients' or 'drinks'
    const result = await callSheetWriter({
      action:   'writeCount',
      store:    session.store,
      type:     type === 'ingredients' ? 'ingredient' : 'drink',
      rowIndex: indexBeforeWrite,
      value:    value,
    });

    if (!result.ok) {
      session.writing  = false;
      sessions[chatId] = session;
      await send(chatId, `⚠️ Error saving count: ${result.error}. Please try again.`);
      return;
    }

    // Store answer in session for review screen
    if (type === 'ingredients') {
      session.answers.ingredients[indexBeforeWrite] = value;
    } else {
      session.answers.drinks[indexBeforeWrite] = value;
    }

    if (session.itemIndex === indexBeforeWrite) session.itemIndex++;
    session.writing  = false;
    sessions[chatId] = session;
    await askNextItem(chatId, session);

  } catch (err) {
    session.writing  = false;
    sessions[chatId] = session;
    await send(chatId, `⚠️ Error saving. Please try again.\n_${err.message}_`);
  }
}

// ── Handle edit during review ─────────────────────────────────
async function handleReviewEdit(chatId, session, text) {
  const items = session.phase === 'review_ingredients'
    ? itemCache[session.store].ingredients
    : itemCache[session.store].drinks;

  // If waiting for a new value after selecting an item number
  if (session.editing !== null) {
    const value = parseFloat(text.replace(/,/g, ''));
    if (isNaN(value) || value < 0) {
      await send(chatId, `⚠️ Please enter a valid number for *${items[session.editing].name}*:`);
      return;
    }

    const editIndex = session.editing;
    const type      = session.phase === 'review_ingredients' ? 'ingredients' : 'drinks';

    // Write corrected value to sheet
    const result = await callSheetWriter({
      action:   'writeCount',
      store:    session.store,
      type:     type === 'ingredients' ? 'ingredient' : 'drink',
      rowIndex: editIndex,
      value:    value,
    });

    if (!result.ok) {
      await send(chatId, `⚠️ Error saving: ${result.error}. Please try again.`);
      return;
    }

    // Update stored answer
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

  // Otherwise expect an item number to edit
  const num = parseInt(text);
  if (isNaN(num) || num < 1 || num > items.length) {
    await send(chatId,
      `⚠️ Please enter a number between *1* and *${items.length}* to select an item to edit.\n` +
      `Or tap ✅ Confirm to proceed.`
    );
    return;
  }

  session.editing  = num - 1; // 0-based index
  sessions[chatId] = session;
  const item = items[num - 1];
  await send(chatId,
    `✏️ Editing *${item.name}*\nCurrent value: *${session.phase === 'review_ingredients' ? session.answers.ingredients[num-1] : session.answers.drinks[num-1]}* ${item.uom}\n\nEnter the correct number:`
  );
}

// ── Finish full submission ────────────────────────────────────
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
      `${icon} *${storeName}* submitted inventory. ✅\n` +
      `⏳ Still waiting for: *${pending.map(s => STORE_NAMES[s]).join(', ')}*`
    );
  }
}

// ── Supplier orders ───────────────────────────────────────────
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
        await send(OWNER_ID,
          `📧 Email draft created for *${supplierName}*${label}\n_Check pizzapleaseordering@gmail.com drafts_`
        );
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

// ── Build order messages ──────────────────────────────────────
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
  if (update.message)        await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
});

// ── Callback handler (Confirm buttons) ───────────────────────
async function handleCallback(query) {
  const chatId = String(query.message.chat.id);
  const data   = query.data;
  const store  = getStore(query.from, chatId);

  await answerCb(query.id);
  if (!store) return;

  const session = sessions[chatId];
  if (!session) return;

  if (data === 'CONFIRM_INGREDIENTS') {
    // Move to drinks phase
    session.phase     = 'drinks';
    session.itemIndex = 0;
    sessions[chatId]  = session;
    await send(chatId,
      `✅ *Ingredients confirmed!* Now let's do the drinks. 🥤\n\n` +
      `${itemCache[session.store].drinks.length} items to go.`
    );
    await askNextItem(chatId, session);
    return;
  }

  if (data === 'CONFIRM_DRINKS') {
    // All done — finish submission
    await finishSubmission(chatId, session);
    return;
  }
}

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
        writing:   false,
        editing:   null,
        answers:   { ingredients: [], drinks: [] },
      };
      await send(chatId,
        `Let's go! 📋\n\n` +
        `I'll ask you for each item one by one.\n` +
        `📦 *Ingredients:* ${items.ingredients.length} items\n` +
        `🥤 *Drinks:* ${items.drinks.length} items\n\n` +
        `You'll get a review screen after each section to check and fix any mistakes.\n\n` +
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

  const session = sessions[chatId];
  if (!session || session.phase === 'done') {
    await send(chatId, `Type *START* to begin your inventory submission.`);
    return;
  }

  // Route to correct handler based on phase
  if (session.phase === 'ingredients' || session.phase === 'drinks') {
    await handleAnswer(chatId, session, text);
  } else if (session.phase === 'review_ingredients' || session.phase === 'review_drinks') {
    await handleReviewEdit(chatId, session, text);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pizza Please Inventory Bot running on port ${PORT}`));
