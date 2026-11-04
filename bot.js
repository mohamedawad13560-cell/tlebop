require("dotenv").config();
const http = require("node:http");
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN مفقود في ملف .env");

const LABELS = {
  cases: "📁 القضايا",
  suspects: "👤 المشتبه بهم",
  evidence: "🧾 الأدلة",
  reports: "📝 التقارير",
  independent_accounts: "🕶️ الحسابات المشبوهة",
};

const SINGLE = {
  cases: "قضية",
  suspects: "مشتبه به",
  evidence: "دليل",
  reports: "تقرير",
  independent_accounts: "حساب مشبوه",
};

const ADD_ACTIONS = {
  cases: "إضافة قضية جديدة",
  suspects: "إضافة مشتبه به جديد",
  evidence: "إضافة دليل جديد",
  reports: "إضافة تقرير جديد",
  independent_accounts: "إضافة حساب مشبوه جديد",
};

const OPTIONAL = new Set([
  "fake_account",
  "suspect_name",
  "text_evidence",
  "file",
]);
const KINDS = Object.keys(LABELS);

const STEPS = {
  cases: [
    ["title", "عنوان القضية؟"],
    ["description", "وصف القضية؟"],
  ],
  suspects: [
    ["name", "اسم المشتبه به؟"],
    ["fake_account", "الحساب الوهمي للمشتبه (يوزر أو رابط)؟ أو اكتب: تخطي"],
    ["details", "المعلومات والوصف؟"],
  ],
  evidence: [
    ["description", "وصف الدليل؟"],
    ["file", "أرسل ملف أو صورة الدليل، أو اكتب: تخطي"],
  ],
  reports: [
    ["title", "عنوان التقرير؟"],
    ["body", "نص التقرير؟"],
  ],
  independent_accounts: [
    ["account_name", "اسم الحساب المشبوه؟"],
    ["account_link", "رابط الحساب المشبوه؟"],
    ["suspect_name", "اسم المشتبه فيه أو رابط حسابه؟ أو اكتب: تخطي"],
    ["text_evidence", "أدلة نصية؟ أو اكتب: تخطي"],
    ["file", "أرسل صورة أو ملف كدليل؟ أو اكتب: تخطي"],
  ],
};

const states = new Map();
const bot = new Telegraf(TOKEN);
let healthServer;

async function startHealthServer() {
  if (process.env.PORT === undefined || process.env.PORT === "") return;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be a valid TCP port");
  healthServer = http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path !== "/" && path !== "/health") {
      res.writeHead(404);
      res.end("Not found\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot is running\n");
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      healthServer.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      healthServer.removeListener("error", onError);
      resolve();
    };
    healthServer.once("error", onError);
    healthServer.once("listening", onListening);
    healthServer.listen(port, "0.0.0.0");
  });
}

const fmtDate = (date) => new Date(date).toLocaleString("en-GB");

function itemTitle(kind, record) {
  if (kind === "cases") return `${db.caseNo(record.id)} | ${record.title}`;
  if (kind === "suspects")
    return `${record.name} (${db.caseNo(record.case_id)})`;
  if (kind === "evidence")
    return `دليل #${record.id}: ${(record.description || "").slice(0, 30)}`;
  if (kind === "independent_accounts")
    return `${record.account_name} (${record.account_link})`;
  return `${record.title} (${db.caseNo(record.case_id)})`;
}

const itemCb = (kind, record) =>
  kind === "cases" ? `case:${record.id}` : `item:${kind}:${record.id}`;

async function itemText(kind, record) {
  const meta = `\n\n🕒 ${fmtDate(record.created_at)}\n✍️ ${record.created_by || "غير محدد"}`;
  if (kind === "cases") {
    const counts = await db.countByCase(record.id);
    return (
      `📁 ${db.caseNo(record.id)} — ${record.title}\nالحالة: ${record.status}\n\n${record.description || ""}\n\n` +
      `👤 مشتبه بهم: ${counts.suspects} | 🧾 أدلة: ${counts.evidence} | 📝 تقارير: ${counts.reports}${meta}`
    );
  }
  if (kind === "independent_accounts") {
    return (
      `🕶️ حساب مشبوه مستقل #${record.id}\nاسم الحساب: ${record.account_name}\nرابط الحساب: ${record.account_link}\n` +
      `المشتبه فيه: ${record.suspect_name || "غير محدد"}\nأدلة نصية: ${record.text_evidence || "لا توجد"}\n` +
      `${record.file_id ? "📎 يوجد مرفق كدليل" : "بدون مرفق"}${meta}`
    );
  }
  const caseLine = `القضية: ${db.caseNo(record.case_id)}\n`;
  if (kind === "suspects") {
    return `👤 ${record.name}\n${caseLine}🎭 الحساب الوهمي: ${record.fake_account || "غير محدد"}\n\n${record.details || ""}${meta}`;
  }
  if (kind === "evidence") {
    return `🧾 دليل #${record.id}\n${caseLine}${record.file_id ? "📎 يوجد مرفق" : "بدون مرفق"}\n\n${record.description}${meta}`;
  }
  return `📝 ${record.title}\n${caseLine}\n${record.body || ""}${meta}`;
}

const backRow = (target = "menu") => [
  Markup.button.callback("⬅️ رجوع", target),
];

const mainMenuRows = (isAdmin) => {
  const rows = [
    [
      Markup.button.callback("📁 القضايا", "list:cases:0"),
      Markup.button.callback("➕ قضية جديدة", "new:cases:0"),
    ],
    [
      Markup.button.callback(
        "🕶️ الحسابات المشبوهة",
        "list:independent_accounts:0",
      ),
      Markup.button.callback(
        "➕ حساب مشبوه جديد",
        "new:independent_accounts:0",
      ),
    ],
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback("🔍 بحث شامل (أدمن)", "search")]);
  }
  return rows;
};

async function show(ctx, text, rows) {
  const keyboard = Markup.inlineKeyboard(rows);
  const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, keyboard);
    } catch (error) {
      if (!/message is not modified/i.test(error.message)) throw error;
    }
  } else {
    await ctx.reply(body, keyboard);
  }
}

const showMenu = async (ctx, user) =>
  show(
    ctx,
    `🕵️ بوت قسم التحقيق\nمرحباً بك: ${user.name}\nالصلاحية: ${user.role === "admin" ? "مشرف 🛡️" : "عضو 👤"}\nاختر القسم:`,
    mainMenuRows(user.role === "admin"),
  );

async function showList(ctx, kind, caseId, user) {
  if (!KINDS.includes(kind)) return showMenu(ctx, user);
  const records = await db.list(kind, caseId);
  const buttons = records.map((record) => [
    Markup.button.callback(itemTitle(kind, record), itemCb(kind, record)),
  ]);
  let back = "menu";
  if (kind === "suspects" || kind === "evidence" || kind === "reports") {
    buttons.push([
      Markup.button.callback(
        `➕ إضافة ${SINGLE[kind]}`,
        `new:${kind}:${caseId}`,
      ),
    ]);
    back = `case:${caseId}`;
  }
  buttons.push(backRow(back));
  const heading = LABELS[kind] + (caseId ? ` — ${db.caseNo(caseId)}` : "");
  await show(
    ctx,
    heading + (records.length ? "" : "\n\nلا توجد سجلات بعد."),
    buttons,
  );
}

async function showCase(ctx, id, user) {
  const record = await db.get("cases", id);
  if (!record) return show(ctx, "القضية غير موجودة.", [backRow()]);
  const rows = [
    [
      Markup.button.callback("👤 المشتبه بهم", `list:suspects:${id}`),
      Markup.button.callback("🧾 الأدلة", `list:evidence:${id}`),
    ],
    [Markup.button.callback("📝 التقارير", `list:reports:${id}`)],
  ];
  if (user.role === "admin") {
    const toggle =
      record.status === "مفتوحة" ? "🔒 إغلاق القضية" : "🔓 إعادة فتح القضية";
    rows.push([Markup.button.callback(toggle, `toggle:${id}`)]);
    rows.push([Markup.button.callback("🗑️ حذف القضية", `delete:cases:${id}`)]);
  }
  rows.push(backRow("list:cases:0"));
  await show(ctx, await itemText("cases", record), rows);
}

async function showItem(ctx, kind, id, user) {
  if (!KINDS.includes(kind) || kind === "cases") return showMenu(ctx, user);
  const record = await db.get(kind, id);
  if (!record) return show(ctx, "السجل غير موجود.", [backRow()]);

  const backTarget =
    kind === "independent_accounts"
      ? "list:independent_accounts:0"
      : `list:${kind}:${record.case_id}`;
  const rows = [backRow(backTarget)];
  if (user.role === "admin") {
    rows.unshift([Markup.button.callback("🗑️ حذف", `delete:${kind}:${id}`)]);
  }

  await show(ctx, await itemText(kind, record), rows);

  const fileId = record.file_id;
  if (fileId) {
    const senders = {
      photo: "replyWithPhoto",
      document: "replyWithDocument",
      video: "replyWithVideo",
      voice: "replyWithVoice",
      audio: "replyWithAudio",
    };
    const send = ctx[senders[record.file_type] || "replyWithDocument"];
    await send.call(ctx, fileId);
  }
}

function extractFile(message) {
  if (message.photo)
    return [message.photo[message.photo.length - 1].file_id, "photo"];
  for (const type of ["document", "video", "voice", "audio"]) {
    if (message[type]) return [message[type].file_id, type];
  }
  return [null, null];
}

// فحص تسجيل المستخدم وصلاحياته لكل رسالة أو تفاعل.
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  let user = await db.getUser(ctx.from.id);

  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (!user) {
    const role = ctx.from.id.toString() === adminId ? "admin" : "member";
    await db.registerUser(ctx.from.id, name, role);
    user = await db.getUser(ctx.from.id);
  }

  if (adminId && ctx.from.id.toString() === adminId) {
    user.role = "admin";
  }

  ctx.state.user = user;
  return next();
});

bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (adminId && ctx.from.id.toString() !== adminId) {
    const name = [ctx.from.first_name, ctx.from.last_name]
      .filter(Boolean)
      .join(" ");
    const username = ctx.from.username ? `@${ctx.from.username}` : "لا يوجد";
    try {
      await ctx.telegram.sendMessage(
        adminId,
        `🚨 تنبيه دخول مستخدم إلى البوت\n\n` +
          `👤 الاسم: ${name}\n` +
          `🔗 اليوزر: ${username}\n` +
          `🆔 الآي دي (Telegram ID): ${ctx.from.id}\n` +
          `🕒 الوقت والتاريخ: ${new Date().toLocaleString("en-GB")}`,
      );
    } catch (err) {
      console.error("فشل إرسال تنبيه الدخول للأدمن:", err);
    }
  }
  await showMenu(ctx, ctx.state.user);
});

bot.command("cancel", async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply(
    "تم الإلغاء.",
    Markup.inlineKeyboard(mainMenuRows(ctx.state.user.role === "admin")),
  );
});

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery();
  const callback = ctx.callbackQuery.data;
  if (typeof callback !== "string") return;
  const [action, arg, value] = callback.split(":");
  const userId = ctx.from.id;
  const user = ctx.state.user;
  states.delete(userId);

  if (action === "menu") return showMenu(ctx, user);
  if (action === "list" && KINDS.includes(arg) && /^\d+$/.test(value || ""))
    return showList(ctx, arg, Number(value), user);
  if (action === "case" && /^\d+$/.test(arg || ""))
    return showCase(ctx, Number(arg), user);
  if (
    action === "item" &&
    KINDS.includes(arg) &&
    arg !== "cases" &&
    /^\d+$/.test(value || "")
  )
    return showItem(ctx, arg, Number(value), user);

  if (action === "toggle" && user.role === "admin" && /^\d+$/.test(arg || "")) {
    const id = Number(arg);
    const record = await db.get("cases", id);
    if (record)
      await db.setStatus(id, record.status === "مفتوحة" ? "مغلقة" : "مفتوحة");
    return showCase(ctx, id, user);
  }

  if (
    action === "delete" &&
    user.role === "admin" &&
    KINDS.includes(arg) &&
    /^\d+$/.test(value || "")
  ) {
    await db.remove(arg, Number(value));
    return ctx.reply(
      "🗑️ تم الحذف بنجاح.",
      Markup.inlineKeyboard(mainMenuRows(user.role === "admin")),
    );
  }

  if (action === "new" && KINDS.includes(arg) && /^\d+$/.test(value || "")) {
    const kind = arg;
    states.set(userId, {
      mode: "new",
      kind,
      caseId: Number(value),
      step: 0,
      data: {},
    });
    return ctx.reply(
      `➕ ${SINGLE[kind]} جديد\n\n${STEPS[kind][0][1]}\n\n(/cancel للإلغاء)`,
    );
  }

  if (action === "search" && user.role === "admin") {
    states.set(userId, { mode: "search" });
    return ctx.reply(
      "🔍 اكتب كلمة البحث الشاملة (اسم، يوزر، قضية، وصف...)\n\n(/cancel للإلغاء)",
    );
  }
});

bot.on("message", async (ctx) => {
  const message = ctx.message;
  if (message.text && message.text.startsWith("/")) return;
  const state = states.get(ctx.from.id);
  const user = ctx.state.user;
  if (!state) return showMenu(ctx, user);

  if (state.mode === "search" && user.role === "admin") {
    const text = (message.text || "").trim();
    if (!text) return ctx.reply("اكتب نصاً للبحث.");
    states.delete(ctx.from.id);
    const results = await db.search(text);
    const buttons = results.map(([kind, record]) => [
      Markup.button.callback(
        `${SINGLE[kind]}: ${itemTitle(kind, record)}`,
        itemCb(kind, record),
      ),
    ]);
    buttons.push(backRow());
    const heading = results.length
      ? `نتائج البحث عن «${text}»: ${results.length}`
      : `لا نتائج لـ «${text}»`;
    return ctx.reply(heading, Markup.inlineKeyboard(buttons));
  }

  const steps = STEPS[state.kind];
  const [field] = steps[state.step];

  if (field === "file") {
    const [fileId, fileType] = extractFile(message);
    if (fileId) {
      state.data.file_id = fileId;
      state.data.file_type = fileType;
    } else if ((message.text || "").trim() !== "تخطي") {
      return ctx.reply("أرسل ملفاً أو صورة كدليل، أو اكتب: تخطي");
    }
  } else {
    if (typeof message.text !== "string")
      return ctx.reply("أرسل نصاً من فضلك.");
    const val = message.text.trim();
    if (!val && !OPTIONAL.has(field))
      return ctx.reply("لا يمكن ترك هذا الحقل فارغاً.");
    state.data[field] = OPTIONAL.has(field) && val === "تخطي" ? null : val;
  }

  state.step += 1;
  if (state.step < steps.length) return ctx.reply(steps[state.step][1]);

  const data = { ...state.data };
  if (state.kind !== "cases" && state.kind !== "independent_accounts")
    data.case_id = state.caseId;
  const createdBy = user.name;
  const newId = await db.add(state.kind, createdBy, data);
  states.delete(ctx.from.id);

  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (adminId) {
    const name =
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
      user.name ||
      "غير معروف";
    const username = ctx.from.username ? `@${ctx.from.username}` : "غير متوفر";
    try {
      await ctx.telegram.sendMessage(
        adminId,
        `📢 تم ${ADD_ACTIONS[state.kind]}\n\n` +
          `👤 اسم المستخدم: ${name}\n` +
          `🔗 اسم الحساب: ${username}\n` +
          `🆔 Telegram ID: ${ctx.from.id}`,
      );
    } catch (error) {
      console.error("فشل إرسال إشعار إضافة سجل للأدمن:", error);
    }
  }

  const target =
    state.kind === "cases"
      ? `case:${newId}`
      : state.kind === "independent_accounts"
        ? `item:independent_accounts:${newId}`
        : `case:${state.caseId}`;
  await ctx.reply(
    `✅ تم حفظ ${SINGLE[state.kind]} بنجاح.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📂 استعراض السجل", target)],
      backRow(),
    ]),
  );
});

bot.catch((error, ctx) => {
  console.error("Bot error:", error);
  return ctx.reply("⚠️ حدث خطأ غير متوقع، حاول مرة أخرى.");
});

(async () => {
  let botStarted = false;
  try {
    await db.init();
    await bot.launch();
    botStarted = true;
    await startHealthServer();
    console.log("Bot is running securely with User Tracking & Roles...");
  } catch (error) {
    if (botStarted) bot.stop();
    if (healthServer && healthServer.listening) {
      await new Promise((resolve) => healthServer.close(resolve));
    }
    try {
      await db.close();
    } catch (closeError) {
      console.error("Failed to close database after startup error:", closeError);
    }
    throw error;
  }
})().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});
