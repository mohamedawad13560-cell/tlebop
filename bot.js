require("dotenv").config();
const http = require("node:http");
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN مفقود في ملف .env");
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID?.trim();
if (!ADMIN_ID || !/^[1-9]\d*$/.test(ADMIN_ID))
  throw new Error("ADMIN_TELEGRAM_ID مفقود أو غير صالح في ملف .env");

const ADMIN_CHAT_ID =
  process.env.ADMIN_CHANNEL_ID?.trim() || process.env.ADMIN_GROUP_ID?.trim();
if (
  !ADMIN_CHAT_ID ||
  (!/^-100\d+$/.test(ADMIN_CHAT_ID) &&
    !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(ADMIN_CHAT_ID)) ||
  (ADMIN_CHAT_ID.startsWith("-") &&
    !Number.isSafeInteger(Number(ADMIN_CHAT_ID)))
)
  throw new Error(
    "ADMIN_CHANNEL_ID (أو ADMIN_GROUP_ID) مفقود أو غير صالح في ملف .env",
  );

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

const OPTIONAL = new Set([
  "fake_account",
  "suspect_name",
  "text_evidence",
  "file",
]);
const KINDS = Object.keys(LABELS);
const CASE_KINDS = new Set(["suspects", "evidence", "reports"]);

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

async function testNotification(ctx) {
  if (ctx.chat?.type !== "private" || ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("هذا الأمر مخصص للأدمن ويُستخدم في المحادثة الخاصة مع البوت.");
  try {
    const destination = await ctx.telegram.getChat(ADMIN_CHAT_ID);
    if (destination.type !== "channel")
      return ctx.reply(
        `وجهة الإشعارات ليست قناة (النوع: ${destination.type}). تحقق من ADMIN_GROUP_ID.`,
      );
    const botMember = await ctx.telegram.getChatMember(
      destination.id,
      ctx.botInfo.id,
    );
    if (
      !["administrator", "creator"].includes(botMember.status) ||
      botMember.can_post_messages === false
    ) {
      return ctx.reply(
        "البوت ليس مشرفاً في القناة أو لا يملك صلاحية نشر الرسائل.",
      );
    }
    await ctx.telegram.sendMessage(
      destination.id,
      "✅ إشعارات بوت التحقيق تعمل بنجاح.",
    );
    return ctx.reply(`تم إرسال رسالة الاختبار إلى قناة «${destination.title}».`);
  } catch (error) {
    const description =
      error.response?.description || error.message || "خطأ غير معروف";
    const code = error.response?.error_code
      ? ` (Telegram ${error.response.error_code})`
      : "";
    console.error(`فشل اختبار إشعار قناة الأدمن${code}: ${description}`);
    return ctx.reply(`تعذر إرسال رسالة الاختبار${code}: ${description}`);
  }
}

bot.command("testnotify", testNotification);

async function startHealthServer() {
  if (process.env.PORT === undefined || process.env.PORT === "") return;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
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

function buttonLabel(text) {
  const chars = Array.from(text);
  return chars.length > 64 ? `${chars.slice(0, 63).join("")}…` : text;
}

function messageText(text, maxUnits = 4000) {
  let result = "";
  let units = 0;
  for (const char of text) {
    if (units + char.length > maxUnits - 1) return `${result}…`;
    result += char;
    units += char.length;
  }
  return result;
}

function itemTitle(kind, record) {
  if (kind === "cases") return `${db.caseNo(record.id)} | ${record.title}`;
  if (kind === "suspects")
    return `${record.name} (${db.caseNo(record.case_id)})`;
  if (kind === "evidence")
    return `دليل #${record.id}: ${Array.from(record.description || "")
      .slice(0, 30)
      .join("")}`;
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
  const body = messageText(text);
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
  if (CASE_KINDS.has(kind) && (!Number.isInteger(caseId) || caseId < 1))
    return show(ctx, "اختر قضية صالحة لعرض هذا القسم.", [backRow()]);
  const records = await db.list(kind, caseId);
  const buttons = records.map((record) => [
    Markup.button.callback(
      buttonLabel(itemTitle(kind, record)),
      itemCb(kind, record),
    ),
  ]);
  let back = "menu";
  if (CASE_KINDS.has(kind)) {
    const caseRecord = await db.get("cases", caseId);
    const canAdd =
      caseRecord &&
      (caseRecord.status !== "مغلقة" || user.role === "admin");
    if (canAdd) {
      buttons.push([
        Markup.button.callback(
          `➕ إضافة ${SINGLE[kind]}`,
          `new:${kind}:${caseId}`,
        ),
      ]);
    }
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

// تسجيل المستخدم وتحديد صلاحياته، دون إرسال إشعار لكل تحديث.
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  let user = await db.getUser(ctx.from.id);

  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");

  if (!user) {
    const role = ctx.from.id.toString() === ADMIN_ID ? "admin" : "member";
    await db.registerUser(ctx.from.id, name, role);
    user = await db.getUser(ctx.from.id);
  }

  if (ctx.from.id.toString() === ADMIN_ID) user.role = "admin";
  ctx.state.user = user;
  return next();
});

bot.start(async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  states.delete(ctx.from.id);
  await showMenu(ctx, ctx.state.user);
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  states.delete(ctx.from.id);
  await ctx.reply(
    "تم الإلغاء.",
    Markup.inlineKeyboard(mainMenuRows(ctx.state.user.role === "admin")),
  );
});

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.chat?.type !== "private")
    return ctx.reply("افتح المحادثة الخاصة مع البوت لاستخدام أزراره.");
  const callback = ctx.callbackQuery.data;
  if (typeof callback !== "string") return;
  const [action, arg, value] = callback.split(":");
  const userId = ctx.from.id;
  const user = ctx.state.user;
  if (!user) return;
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
    if (record) {
      const newStatus = record.status === "مفتوحة" ? "مغلقة" : "مفتوحة";
      await db.setStatus(id, newStatus);

      let notificationError;
      try {
        await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `تحديث حالة قضية بواسطة الأدمن\n\n` +
            `📁 القضية: ${db.caseNo(id)} - ${record.title}\n` +
            `📌 الحالة الجديدة: ${newStatus}\n` +
            `🕒 الوقت: ${new Date().toLocaleString("en-GB")}`,
        );
      } catch (error) {
        notificationError =
          error.response?.description || error.message || "خطأ غير معروف";
        console.error("فشل إشعار تغيير حالة القضية:", notificationError);
      }
      await showCase(ctx, id, user);
      if (notificationError)
        return ctx.reply(
          `تم تحديث حالة القضية، لكن تعذر إرسال الإشعار: ${notificationError}`,
        );
      return;
    }
    return showCase(ctx, id, user);
  }

  if (
    action === "delete" &&
    user.role === "admin" &&
    KINDS.includes(arg) &&
    /^\d+$/.test(value || "")
  ) {
    const removed = await db.remove(arg, Number(value));
    if (!removed)
      return ctx.reply(
        "السجل غير موجود أو تم حذفه مسبقاً.",
        Markup.inlineKeyboard(mainMenuRows(user.role === "admin")),
      );
    return ctx.reply(
      "🗑️ تم الحذف بنجاح.",
      Markup.inlineKeyboard(mainMenuRows(user.role === "admin")),
    );
  }

  if (action === "new" && KINDS.includes(arg) && /^\d+$/.test(value || "")) {
    const kind = arg;
    const caseId = Number(value);
    if (CASE_KINDS.has(kind)) {
      if (!Number.isSafeInteger(caseId) || caseId < 1)
        return ctx.reply("❌ اختر قضية صالحة قبل إضافة هذا السجل.");
      const caseRecord = await db.get("cases", caseId);
      if (!caseRecord)
        return ctx.reply("❌ القضية غير موجودة.");
      if (caseRecord.status === "مغلقة" && user.role !== "admin") {
        return ctx.reply(
          "❌ هذه القضية مغلقة ولا يمكن إضافة بيانات جديدة إليها حالياً.",
        );
      }
    }
    states.set(userId, {
      mode: "new",
      kind,
      caseId,
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
  if (ctx.chat.type !== "private") return;
  const message = ctx.message;
  if (
    typeof message.text === "string" &&
    /^\/testnotify(?:@\w+)?(?:\s|$)/i.test(message.text)
  ) {
    return testNotification(ctx);
  }
  if (message.text && message.text.startsWith("/")) return;
  const state = states.get(ctx.from.id);
  const user = ctx.state.user;
  if (!user) return ctx.reply("تعذر التحقق من حسابك. أرسل /start مجدداً.");
  if (!state) return showMenu(ctx, user);

  if (state.mode === "search" && user.role === "admin") {
    const text = (message.text || "").trim();
    if (!text) return ctx.reply("اكتب نصاً للبحث.");
    states.delete(ctx.from.id);
    const results = await db.search(text);
    const buttons = results.map(([kind, record]) => [
      Markup.button.callback(
        buttonLabel(`${SINGLE[kind]}: ${itemTitle(kind, record)}`),
        itemCb(kind, record),
      ),
    ]);
    buttons.push(backRow());
    const query = messageText(text, 300);
    const heading = results.length
      ? `نتائج البحث عن «${query}»: ${results.length}`
      : `لا نتائج لـ «${query}»`;
    return ctx.reply(heading, Markup.inlineKeyboard(buttons));
  }

  const steps = STEPS[state.kind];
  const step = steps?.[state.step];
  if (!step) {
    states.delete(ctx.from.id);
    return ctx.reply("انتهت صلاحية نموذج الإدخال. ابدأ الإضافة من جديد.");
  }
  const [field] = step;

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
  if (CASE_KINDS.has(state.kind)) {
    const caseRecord = await db.get("cases", state.caseId);
    if (!caseRecord) {
      states.delete(ctx.from.id);
      return ctx.reply("❌ القضية لم تعد موجودة، تم إلغاء الإضافة.");
    }
    if (caseRecord.status === "مغلقة" && user.role !== "admin") {
      states.delete(ctx.from.id);
      return ctx.reply("❌ أُغلقت القضية أثناء الإضافة، لذلك لم يتم حفظ السجل.");
    }
  }
  const createdBy = user.name;
  states.delete(ctx.from.id);
  let newId;
  try {
    newId = await db.add(state.kind, createdBy, data);
  } catch (error) {
    console.error("فشل حفظ سجل جديد في قاعدة البيانات:", error);
    return ctx.reply(
      "❌ تعذر حفظ البيانات في قاعدة البيانات. تحقق من اتصال MySQL ثم أعد المحاولة.",
    );
  }

  // إرسال إشعار فوري لـ "جروب الأدمنز" بأن شخصاً ما حفظ سجل جديد مع تفاصيل البيانات المضافة
  const name =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
    user.name ||
    "غير معروف";
  const username = ctx.from.username ? `@${ctx.from.username}` : "بدون يوزر";
  const detailsSummary =
    state.kind === "cases"
      ? `عنوان القضية: ${data.title}\nالوصف: ${(data.description || "بدون").slice(0, 500)}`
      : state.kind === "independent_accounts"
        ? `اسم الحساب: ${data.account_name}\nالرابط: ${data.account_link}\nالمشتبه به: ${data.suspect_name || "بدون"}`
        : `القضية: ${db.caseNo(state.caseId)}`;
  let notificationError;
  try {
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `تمت إضافة ${SINGLE[state.kind]} جديدة\n\n` +
        `👤 المستخدم: ${name}\n` +
        `🔗 الحساب: ${username}\n` +
        `🆔 Telegram ID: ${ctx.from.id}\n` +
        `📌 رقم السجل: #${newId}\n` +
        `${detailsSummary}`,
    );
  } catch (error) {
    notificationError =
      error.response?.description || error.message || "خطأ غير معروف";
    console.error("فشل إرسال إشعار إضافة سجل لجروب الأدمن:", notificationError);
  }

  const target =
    state.kind === "cases"
      ? `case:${newId}`
      : state.kind === "independent_accounts"
        ? `item:independent_accounts:${newId}`
        : `case:${state.caseId}`;
  await ctx.reply(
    notificationError
      ? `✅ تم حفظ ${SINGLE[state.kind]} بنجاح، لكن تعذر إشعار جروب الأدمن: ${notificationError}`
      : `✅ تم حفظ ${SINGLE[state.kind]} بنجاح وإشعار جروب الأدمن.`,
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
    console.log("Bot is running securely with Group Notifications...");
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
