require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN مفقود في ملف .env");

const LABELS = {
  cases: "📁 القضايا",
  suspects: "👤 المشتبه بهم",
  evidence: "🧾 الأدلة",
  reports: "📝 التقارير",
  accounts: "🕶️ الحسابات المشبوهة",
};
const SINGLE = {
  cases: "قضية",
  suspects: "مشتبه به",
  evidence: "دليل",
  reports: "تقرير",
  accounts: "حساب مشبوه",
};
const OPTIONAL = new Set(["fake_account"]);
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
  accounts: [
    ["platform", "المنصة؟ (تيليجرام، انستغرام، فيسبوك...)"],
    ["username", "اسم المستخدم أو رابط الحساب؟"],
    ["details", "ملاحظات وسبب الاشتباه؟"],
  ],
};

const states = new Map();
const bot = new Telegraf(TOKEN);

const fmtDate = (date) => new Date(date).toLocaleString("en-GB");

function itemTitle(kind, record) {
  if (kind === "cases") return `${db.caseNo(record.id)} | ${record.title}`;
  if (kind === "suspects")
    return `${record.name} (${db.caseNo(record.case_id)})`;
  if (kind === "evidence")
    return `دليل #${record.id}: ${(record.description || "").slice(0, 30)}`;
  if (kind === "accounts")
    return `${record.platform}: ${record.username} (${db.caseNo(record.case_id)})`;
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
      `👤 مشتبه بهم: ${counts.suspects} | 🧾 أدلة: ${counts.evidence} | 📝 تقارير: ${counts.reports} | 🕶️ حسابات مشبوهة: ${counts.accounts}${meta}`
    );
  }

  const caseLine = `القضية: ${db.caseNo(record.case_id)}\n`;
  if (kind === "suspects") {
    return `👤 ${record.name}\n${caseLine}🎭 الحساب الوهمي: ${record.fake_account || "غير محدد"}\n\n${record.details || ""}${meta}`;
  }
  if (kind === "accounts") {
    return `🕶️ حساب مشبوه #${record.id}\n${caseLine}المنصة: ${record.platform}\nالحساب: ${record.username}\n\n${record.details || ""}${meta}`;
  }
  if (kind === "evidence") {
    return `🧾 دليل #${record.id}\n${caseLine}${record.file_id ? "📎 يوجد مرفق" : "بدون مرفق"}\n\n${record.description}${meta}`;
  }
  return `📝 ${record.title}\n${caseLine}\n${record.body || ""}${meta}`;
}

const backRow = (target = "menu") => [
  Markup.button.callback("⬅️ رجوع", target),
];

const mainMenuRows = () => [
  [
    Markup.button.callback("📁 القضايا", "list:cases:0"),
    Markup.button.callback("➕ قضية جديدة", "new:cases:0"),
  ],
  [
    Markup.button.callback("👤 المشتبه بهم", "list:suspects:0"),
    Markup.button.callback("🧾 الأدلة", "list:evidence:0"),
  ],
  [
    Markup.button.callback("📝 التقارير", "list:reports:0"),
    Markup.button.callback("🕶️ الحسابات المشبوهة", "list:accounts:0"),
  ],
  [Markup.button.callback("🔍 بحث", "search")],
];

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

const showMenu = (ctx) =>
  show(ctx, "🕵️ بوت قسم التحقيق\nاختر القسم:", mainMenuRows());

async function showList(ctx, kind, caseId) {
  if (!KINDS.includes(kind)) return showMenu(ctx);
  const records = await db.list(kind, caseId);
  const buttons = records.map((record) => [
    Markup.button.callback(itemTitle(kind, record), itemCb(kind, record)),
  ]);
  let back = "menu";
  if (kind !== "cases" && caseId) {
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

async function showCase(ctx, id) {
  const record = await db.get("cases", id);
  if (!record) return show(ctx, "القضية غير موجودة.", [backRow()]);
  const toggle =
    record.status === "مفتوحة" ? "🔒 إغلاق القضية" : "🔓 إعادة فتح القضية";
  await show(ctx, await itemText("cases", record), [
    [
      Markup.button.callback("👤 المشتبه بهم", `list:suspects:${id}`),
      Markup.button.callback("🧾 الأدلة", `list:evidence:${id}`),
    ],
    [
      Markup.button.callback("📝 التقارير", `list:reports:${id}`),
      Markup.button.callback("🕶️ الحسابات المشبوهة", `list:accounts:${id}`),
    ],
    [Markup.button.callback(toggle, `toggle:${id}`)],
    backRow("list:cases:0"),
  ]);
}

async function showItem(ctx, kind, id) {
  if (!KINDS.includes(kind) || kind === "cases")
    return showMenu(ctx);
  const record = await db.get(kind, id);
  if (!record) return show(ctx, "السجل غير موجود.", [backRow()]);
  await show(ctx, await itemText(kind, record), [
    backRow(`list:${kind}:${record.case_id}`),
  ]);
  if (kind === "evidence" && record.file_id) {
    const senders = {
      photo: "replyWithPhoto",
      video: "replyWithVideo",
      voice: "replyWithVoice",
      audio: "replyWithAudio",
      document: "replyWithDocument",
    };
    const send = ctx[senders[record.file_type] || "replyWithDocument"];
    await send.call(ctx, record.file_id);
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

bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  await showMenu(ctx);
});

bot.command("cancel", async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply("تم الإلغاء.", Markup.inlineKeyboard(mainMenuRows()));
});

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery();
  const callback = ctx.callbackQuery.data;
  if (typeof callback !== "string") return;
  const [action, arg, value] = callback.split(":");
  const userId = ctx.from.id;
  states.delete(userId);

  if (action === "menu") return showMenu(ctx);
  if (action === "list" && KINDS.includes(arg) && /^\d+$/.test(value || ""))
    return showList(ctx, arg, Number(value));
  if (action === "case" && /^\d+$/.test(arg || ""))
    return showCase(ctx, Number(arg));
  if (
    action === "item" &&
    KINDS.includes(arg) &&
    arg !== "cases" &&
    /^\d+$/.test(value || "")
  ) {
    return showItem(ctx, arg, Number(value));
  }
  if (action === "toggle" && /^\d+$/.test(arg || "")) {
    const id = Number(arg);
    const record = await db.get("cases", id);
    if (record)
      await db.setStatus(
        id,
        record.status === "مفتوحة" ? "مغلقة" : "مفتوحة",
      );
    return showCase(ctx, id);
  }
  if (
    action === "new" &&
    KINDS.includes(arg) &&
    /^\d+$/.test(value || "") &&
    (arg === "cases" || Number(value) > 0)
  ) {
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
  if (action === "search") {
    states.set(userId, { mode: "search" });
    return ctx.reply(
      "🔍 اكتب كلمة البحث (اسم، رقم قضية، وصف...)\n\n(/cancel للإلغاء)",
    );
  }
});

bot.on("message", async (ctx) => {
  const message = ctx.message;
  if (message.text && message.text.startsWith("/")) return;
  const state = states.get(ctx.from.id);
  if (!state) return showMenu(ctx);

  if (state.mode === "search") {
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
      return ctx.reply("أرسل ملفاً أو صورة، أو اكتب: تخطي");
    }
  } else {
    if (typeof message.text !== "string")
      return ctx.reply("أرسل نصاً من فضلك.");
    const value = message.text.trim();
    if (!value && !OPTIONAL.has(field))
      return ctx.reply("لا يمكن ترك هذا الحقل فارغاً.");
    state.data[field] =
      OPTIONAL.has(field) && value === "تخطي" ? null : value;
  }

  state.step += 1;
  if (state.step < steps.length) return ctx.reply(steps[state.step][1]);

  const data = { ...state.data };
  if (state.kind !== "cases") data.case_id = state.caseId;
  const createdBy = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");
  const newId = await db.add(state.kind, createdBy, data);
  states.delete(ctx.from.id);
  const target =
    state.kind === "cases" ? `case:${newId}` : `case:${state.caseId}`;
  await ctx.reply(
    `✅ تم حفظ ${SINGLE[state.kind]} بنجاح.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📂 فتح القضية", target)],
      backRow(),
    ]),
  );
});

bot.catch((error, ctx) => {
  console.error("Bot error:", error);
  return ctx.reply("⚠️ حدث خطأ غير متوقع، حاول مرة أخرى.").catch((replyError) => {
    console.error("Failed to notify user:", replyError);
  });
});

(async () => {
  await db.init();
  await bot.launch();
  console.log("Bot is running...");
})().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
