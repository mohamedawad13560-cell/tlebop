require("dotenv").config();
const http = require("node:http");
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN مفقود في ملف .env");

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID?.trim();
if (!ADMIN_ID || !/^[1-9]\d*$/.test(ADMIN_ID))
  throw new Error("ADMIN_TELEGRAM_ID مفقود أو غير صالح في ملف .env");

const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID?.trim();

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

const STEPS = {
  cases: [
    ["title", "عنوان القضية؟"],
    ["description", "وصف القضية؟"],
  ],
  case_suspect: [
    ["name", "اسم المشتبه به؟"],
    ["primary_account", "الحساب الأساسي للمشتبه به (يوزر أو رابط)؟"],
    ["fake_account", "الحساب الوهمي للمشتبه (يوزر أو رابط)؟ أو اكتب: تخطي"],
    ["evidence_description", "صف الدليل المرتبط بالمشتبه به؟"],
    ["file", "أرسل ملف أو صورة الدليل، أو اكتب: تخطي"],
  ],
  suspects: [
    ["name", "اسم المشتبه به؟"],
    ["primary_account", "الحساب الأساسي للمشتبه به (يوزر أو رابط)؟"],
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
  new_task: [
    ["title", "اسم المهمة المطلوبة؟"],
    ["details", "تفاصيل وتوجيهات المهمة؟"],
    [
      "max_members",
      "عدد الأعضاء المطلوبين لقبول المهمة؟ (اكتب رقماً فقط، مثل: 2)",
    ],
  ],
  task_finish_report: [
    ["report", "اكتب تقرير وتفاصيل إنجاز المهمة (أو أرسل ملف/صورة الإنجاز):"],
  ],
};

const states = new Map();
const bot = new Telegraf(TOKEN);
let healthServer;

async function startHealthServer() {
  if (process.env.PORT === undefined || process.env.PORT === "") return;
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a valid TCP port");
  healthServer = http.createServer((req, res) => {
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
    return `👤 ${record.name}\n${caseLine}👤 الحساب الأساسي: ${record.primary_account || "غير محدد"}\n🎭 الحساب الوهمي: ${record.fake_account || "غير محدد"}\n\n${record.details || ""}${meta}`;
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
    [Markup.button.callback("📋 قائمة المهام", "tasks_list")],
  ];
  if (isAdmin) {
    rows.push([
      Markup.button.callback("➕ إضافة مهمة جديدة", "new_task"),
      Markup.button.callback("🔍 بحث شامل (أدمن)", "search"),
    ]);
    rows.push([
      Markup.button.callback("📢 إرسال إشعار عام (Broadcast)", "broadcast"),
    ]);
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
  let caseRecord = null;
  if (caseId && ["suspects", "evidence", "reports"].includes(kind)) {
    caseRecord = await db.get("cases", caseId);
    if (
      caseRecord?.status === "مغلقة" &&
      user.role !== "admin"
    ) {
      return show(ctx, "❌ هذه القضية مغلقة وغير متاحة.", [backRow()]);
    }
  }
  const records = await db.list(kind, caseId);
  const buttons = records.map((record) => [
    Markup.button.callback(itemTitle(kind, record), itemCb(kind, record)),
  ]);
  let back = "menu";
  if (kind === "suspects" || kind === "evidence" || kind === "reports") {
    const canAdd = !caseRecord || caseRecord.status !== "مغلقة";
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
  if (record.status === "مغلقة" && user.role !== "admin")
    return show(ctx, "❌ هذه القضية مغلقة وغير متاحة.", [backRow()]);
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

async function saveCaseDraft(ctx, user, state) {
  const caseId = await db.createCaseWithDetails(
    state.data,
    state.suspects,
    state.evidences,
    user.name,
  );
  states.delete(ctx.from.id);

  if (ADMIN_GROUP_ID) {
    try {
      await ctx.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `🚨 **تم حفظ قضية جديدة بواسطة عضو!**\n\n` +
          `👤 العضو: ${user.name} (@${ctx.from.username || "بدون"})\n` +
          `📁 القضية: ${db.caseNo(caseId)} - ${state.data.title}\n` +
          `👥 عدد المشتبه بهم: ${state.suspects.length}\n` +
          `🧾 عدد الأدلة: ${state.evidences.length}\n` +
          `🕒 الوقت والتاريخ: ${new Date().toLocaleString("en-GB")}`,
      );
    } catch (error) {
      console.error("خطأ في إرسال إشعار القضية الجديدة لجروب الأدمنز:", error);
    }
  }

  return ctx.reply(
    `✅ تم حفظ القضية ${db.caseNo(caseId)} مع ${state.suspects.length} مشتبه بهم و${state.evidences.length} أدلة.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📂 استعراض القضية", `case:${caseId}`)],
      backRow(),
    ]),
  );
}

async function showItem(ctx, kind, id, user) {
  if (!KINDS.includes(kind) || kind === "cases") return showMenu(ctx, user);
  const record = await db.get(kind, id);
  if (!record) return show(ctx, "السجل غير موجود.", [backRow()]);
  if (
    record.case_id &&
    user.role !== "admin" &&
    (await db.get("cases", record.case_id))?.status === "مغلقة"
  ) {
    return show(ctx, "❌ بيانات هذه القضية المغلقة غير متاحة.", [backRow()]);
  }

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

// عرض قائمة المهام
async function showTasksList(ctx, user) {
  const tasks = await db.listTasks();
  const buttons = tasks.map((t) => [
    Markup.button.callback(`📋 ${t.title} [${t.status}]`, `task_view:${t.id}`),
  ]);
  buttons.push(backRow());
  await show(
    ctx,
    "📋 **قائمة المهام المتاحة:**\nاختر المهمة لعرض التفاصيل وقبولها:",
    buttons,
  );
}

// عرض تفاصيل مهمة
async function showTaskView(ctx, taskId, user) {
  const task = await db.getTask(taskId);
  if (!task) return ctx.reply("المهمة غير موجودة.");

  const assignments = await db.getTaskAssignments(taskId);
  const isUserAccepted = assignments.some((a) => a.telegram_id == ctx.from.id);

  let assigneesText = assignments.length
    ? assignments.map((a) => `• ${a.user_name}`).join("\n")
    : "لم يقبلها أحد بعد.";

  const text =
    `📋 **المهمة #${task.id}: ${task.title}**\n\n` +
    `📝 **التفاصيل:**\n${task.details}\n\n` +
    `👥 **المطلوب قبولهم:** ${assignments.length} من ${task.max_members}\n` +
    `📌 **الأعضاء المقبولين حالياً:**\n${assigneesText}\n\n` +
    `📊 **الحالة:** ${task.status}\n` +
    `✍️ **المُنشئ:** ${task.created_by}\n` +
    `🕒 **الوقت:** ${fmtDate(task.created_at)}`;

  const buttons = [];

  if (task.status !== "منتهية") {
    if (isUserAccepted) {
      buttons.push([
        Markup.button.callback(
          "🏁 إكمال المهمة وإرسال التقرير",
          `task_finish:${task.id}`,
        ),
        Markup.button.callback(
          "🚪 الانسحاب من المهمة",
          `task_withdraw:${task.id}`,
        ),
      ]);
    } else if (assignments.length < task.max_members) {
      buttons.push([
        Markup.button.callback("✅ قبول المهمة", `task_accept:${task.id}`),
      ]);
    }
  }

  if (user.role === "admin") {
    buttons.push([
      Markup.button.callback("🗑️ حذف المهمة (أدمن)", `task_delete:${task.id}`),
    ]);
  }

  buttons.push(backRow("tasks_list"));
  await show(ctx, text, buttons);
}

function extractFile(message) {
  if (message.photo)
    return [message.photo[message.photo.length - 1].file_id, "photo"];
  for (const type of ["document", "video", "voice", "audio"]) {
    if (message[type]) return [message[type].file_id, type];
  }
  return [null, null];
}

// فحص التسجيل وتنبيهات الجروب
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (ctx.chat && ctx.chat.type !== "private") return next();

  let user = await db.getUser(ctx.from.id);
  const isNewUser = !user;

  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");
  const username = ctx.from.username ? `@${ctx.from.username}` : "لا يوجد";
  if (!user) {
    const role = ctx.from.id.toString() === ADMIN_ID ? "admin" : "member";
    await db.registerUser(ctx.from.id, name, role);
    user = await db.getUser(ctx.from.id);
  }

  if (
    isNewUser &&
    ADMIN_GROUP_ID &&
    ctx.from.id.toString() !== ADMIN_ID
  ) {
    try {
      await ctx.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `🆕 **مستخدم جديد دخل البوت!**\n\n` +
          `👤 الاسم: ${name}\n` +
          `🔗 اليوزر: ${username}\n` +
          `🆔 الآي دي: \`${ctx.from.id}\`\n` +
          `🕒 الوقت والتاريخ: ${new Date().toLocaleString("en-GB")}`,
      );
    } catch (err) {
      console.error("فشل إرسال تنبيه المستخدم الجديد لجروب الأدمنز:", err);
    }
  }

  ctx.state.user = user;
  return next();
});

bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;
  states.delete(ctx.from.id);
  await showMenu(ctx, ctx.state.user);
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
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
  if (!user) return;
  const state = states.get(userId);

  if (action === "case_draft_add" && state?.mode === "case_suspect") {
    if (!state.readyToSave)
      return ctx.reply("أكمل بيانات المشتبه به والدليل الحالي أولاً.");
    state.step = 0;
    state.readyToSave = false;
    state.currentSuspect = {};
    return ctx.reply(
      `👤 بيانات المشتبه به الجديد\n\n${STEPS.case_suspect[0][1]}`,
    );
  }
  if (action === "case_draft_save" && state?.mode === "case_suspect") {
    if (!state.readyToSave)
      return ctx.reply("أكمل بيانات المشتبه به والدليل الحالي أولاً.");
    return saveCaseDraft(ctx, user, state);
  }

  states.delete(userId);

  if (action === "menu") return showMenu(ctx, user);
  if (action === "tasks_list") return showTasksList(ctx, user);
  if (action === "task_view" && /^\d+$/.test(arg || ""))
    return showTaskView(ctx, Number(arg), user);

  // قبول المهمة
  if (action === "task_accept" && /^\d+$/.test(arg || "")) {
    const res = await db.acceptTask(Number(arg), userId, user.name);
    if (!res.success) {
      await ctx.reply(res.message);
    } else {
      await ctx.reply("✅ تم قبول المهمة بنجاح! بالتوفيق في إنجازها.");
    }
    return showTaskView(ctx, Number(arg), user);
  }

  // الانسحاب من المهمة
  if (action === "task_withdraw" && /^\d+$/.test(arg || "")) {
    await db.withdrawTask(Number(arg), userId);
    await ctx.reply("🚪 تم انسحابك من المهمة.");
    return showTaskView(ctx, Number(arg), user);
  }

  // إكمال المهمة (بدء استقبال التقرير)
  if (action === "task_finish" && /^\d+$/.test(arg || "")) {
    const taskId = Number(arg);
    const task = await db.getTask(taskId);
    const assignments = task ? await db.getTaskAssignments(taskId) : [];
    if (
      !task ||
      task.status === "منتهية" ||
      !assignments.some((assignment) => assignment.telegram_id == userId)
    ) {
      return ctx.reply("لا يمكنك إكمال هذه المهمة أو أنها لم تعد متاحة.");
    }
    states.set(userId, { mode: "task_finish_report", taskId });
    return ctx.reply(
      "📝 أرسل الآن تقرير إنجاز المهمة أو تفاصيل الانتهاء (مع إمكانية إرفاق صورة/ملف):",
    );
  }

  // حذف المهمة (أدمن)
  if (
    action === "task_delete" &&
    user.role === "admin" &&
    /^\d+$/.test(arg || "")
  ) {
    await db.deleteTask(Number(arg));
    await ctx.reply("🗑️ تم حذف المهمة بنجاح.");
    return showTasksList(ctx, user);
  }

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

      if (ADMIN_GROUP_ID) {
        await ctx.telegram
          .sendMessage(
            ADMIN_GROUP_ID,
            `🔓 **تحديث حالة قضية بواسطة الأدمن**\n\n` +
              `📁 القضية: ${db.caseNo(id)} - ${record.title}\n` +
              `📌 الحالة الجديدة: ${newStatus}\n` +
              `🕒 الوقت: ${new Date().toLocaleString("en-GB")}`,
          )
          .catch(() => {});
      }
    }
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
    if (Number(value) > 0) {
      const caseRecord = await db.get("cases", Number(value));
      if (
        caseRecord &&
        caseRecord.status === "مغلقة" &&
        user.role !== "admin"
      ) {
        return ctx.reply(
          "❌ هذه القضية مغلقة ولا يمكن إضافة بيانات جديدة إليها حالياً.",
        );
      }
    }
    if (kind === "cases") {
      states.set(userId, {
        mode: "new_case",
        step: 0,
        data: {},
        suspects: [],
        evidences: [],
        readyToSave: false,
      });
      return ctx.reply(
        `➕ قضية جديدة\n\n${STEPS.cases[0][1]}\n\n(/cancel للإلغاء)`,
      );
    }
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

  // إنشاء مهمة جديدة (أدمن)
  if (action === "new_task" && user.role === "admin") {
    states.set(userId, { mode: "new_task", kind: "task", step: 0, data: {} });
    return ctx.reply(
      `➕ **إنشاء مهمة جديدة**\n\n${STEPS.new_task[0][1]}\n\n(/cancel للإلغاء)`,
    );
  }

  if (action === "search" && user.role === "admin") {
    states.set(userId, { mode: "search" });
    return ctx.reply(
      "🔍 اكتب كلمة البحث الشاملة (اسم، يوزر، قضية، وصف...)\n\n(/cancel للإلغاء)",
    );
  }

  if (action === "broadcast" && user.role === "admin") {
    states.set(userId, { mode: "broadcast" });
    return ctx.reply(
      "📢 **إرسال إشعار عام:**\nاكتب نص الرسالة التي تريد إرسالها لجميع مستخدمي البوت.\n\n(/cancel للإلغاء)",
    );
  }
});

bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const message = ctx.message;
  if (message.text && message.text.startsWith("/")) return;
  const state = states.get(ctx.from.id);
  const user = ctx.state.user;
  if (!user || !state) return showMenu(ctx, user);

  if (state.mode === "new_case") {
    const [field] = STEPS.cases[state.step];
    if (typeof message.text !== "string")
      return ctx.reply("أرسل نصاً من فضلك.");
    const val = message.text.trim();
    if (!val) return ctx.reply("لا يمكن ترك هذا الحقل فارغاً.");
    state.data[field] = val;
    state.step += 1;
    if (state.step < STEPS.cases.length)
      return ctx.reply(STEPS.cases[state.step][1]);

    state.mode = "case_suspect";
    state.step = 0;
    state.currentSuspect = {};
    return ctx.reply(
      `✅ تم إدخال بيانات القضية. يجب إضافة مشتبه به واحد على الأقل ودليل واحد على الأقل.\n\n` +
        `👤 بيانات المشتبه به الأول\n${STEPS.case_suspect[0][1]}`,
    );
  }

  if (state.mode === "case_suspect") {
    const [field] = STEPS.case_suspect[state.step];
    if (field === "file") {
      const [fileId, fileType] = extractFile(message);
      if (fileId) {
        state.currentSuspect.file_id = fileId;
        state.currentSuspect.file_type = fileType;
      } else if ((message.text || "").trim() !== "تخطي") {
        return ctx.reply("أرسل ملفاً أو صورة كدليل، أو اكتب: تخطي");
      }
    } else {
      if (typeof message.text !== "string")
        return ctx.reply("أرسل نصاً من فضلك.");
      const val = message.text.trim();
      if (!val && !OPTIONAL.has(field))
        return ctx.reply("لا يمكن ترك هذا الحقل فارغاً.");
      state.currentSuspect[field] =
        OPTIONAL.has(field) && val === "تخطي" ? null : val;
    }

    state.step += 1;
    if (state.step < STEPS.case_suspect.length)
      return ctx.reply(STEPS.case_suspect[state.step][1]);

    const {
      evidence_description: description,
      file_id,
      file_type,
      ...suspect
    } = state.currentSuspect;
    state.suspects.push(suspect);
    state.evidences.push({ description, file_id, file_type });
    state.currentSuspect = {};
    state.step = 0;
    state.readyToSave = true;
    return ctx.reply(
      `تمت إضافة المشتبه به والدليل. عدد المشتبه بهم: ${state.suspects.length}، وعدد الأدلة: ${state.evidences.length}.\nهل تريد إضافة مشتبه به آخر أم حفظ القضية؟`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ إضافة مشتبه به آخر", "case_draft_add")],
        [Markup.button.callback("💾 حفظ القضية", "case_draft_save")],
      ]),
    );
  }

  // إرسال إنجاز المهمة والتقرير
  if (state.mode === "task_finish_report") {
    const [fileId, fileType] = extractFile(message);
    const reportText = typeof message.text === "string" ? message.text.trim() : "";
    if (!reportText && !fileId)
      return ctx.reply("أرسل تقريراً نصياً أو أرفق ملفاً أو صورة للإنجاز.");

    const taskId = state.taskId;
    const task = await db.getTask(taskId);
    const assignments = task ? await db.getTaskAssignments(taskId) : [];
    if (
      !task ||
      task.status === "منتهية" ||
      !assignments.some((assignment) => assignment.telegram_id == ctx.from.id)
    ) {
      states.delete(ctx.from.id);
      return ctx.reply("تعذر إكمال المهمة؛ قد تكون حُذفت أو أُغلقت بالفعل.");
    }

    await db.completeTask(taskId);
    states.delete(ctx.from.id);

    // إرسال إشعار تفصيلي لجروب الأدمنز بالإنجاز
    if (ADMIN_GROUP_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🏁 **تم إنجاز مهمة وإغلاقها بنجاح!**\n\n` +
            `📋 المهمة: ${task.title}\n` +
            `👤 بواسطة العضو: ${user.name} (@${ctx.from.username || "بدون"})\n` +
            `📝 التقرير:\n${reportText}\n\n` +
            `🕒 الوقت: ${new Date().toLocaleString("en-GB")}`,
        );
        if (fileId) {
          const senders = {
            photo: "sendPhoto",
            document: "sendDocument",
            video: "sendVideo",
            voice: "sendVoice",
            audio: "sendAudio",
          };
          const send = ctx.telegram[senders[fileType] || "sendDocument"];
          await send.call(ctx.telegram, ADMIN_GROUP_ID, fileId);
        }
      } catch (err) {
        console.error("خطأ في إرسال تقرير المهمة للجروب:", err);
      }
    }

    return ctx.reply(
      "✅ تم إرسال تقرير إنجاز المهمة بنجاح للإدارة وإغلاق المهمة.",
      Markup.inlineKeyboard([backRow("tasks_list")]),
    );
  }

  // استكمال خطوات إنشاء مهمة جديدة (أدمن)
  if (state.mode === "new_task" && user.role === "admin") {
    const steps = STEPS.new_task;
    const [field] = steps[state.step];

    if (field === "max_members") {
      const val = Number((message.text || "").trim());
      if (!Number.isInteger(val) || val < 1)
        return ctx.reply("يرجى كتابة رقم صحيح أكبر من أو يساوي 1.");
      state.data[field] = val;
    } else {
      if (typeof message.text !== "string")
        return ctx.reply("أرسل نصاً من فضلك.");
      const val = message.text.trim();
      if (!val) return ctx.reply("لا يمكن ترك هذا الحقل فارغاً.");
      state.data[field] = val;
    }

    state.step += 1;
    if (state.step < steps.length) return ctx.reply(steps[state.step][1]);

    // حفظ المهمة في قاعدة البيانات
    const data = state.data;
    const newTaskId = await db.addTask(
      data.title,
      data.details,
      data.max_members,
      user.name,
    );
    states.delete(ctx.from.id);

    if (ADMIN_GROUP_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `📋 **تمت إضافة مهمة جديدة!**\n\n` +
            `📌 العنوان: ${data.title}\n` +
            `📝 التفاصيل: ${data.details}\n` +
            `👥 العدد المطلوب: ${data.max_members}\n` +
            `✍️ بواسطة: ${user.name}\n` +
            `🆔 رقم المهمة: #${newTaskId}\n` +
            `🕒 الوقت: ${new Date().toLocaleString("en-GB")}`,
        );
      } catch (err) {
        console.error("فشل إرسال تنبيه المهمة الجديدة لجروب الأدمنز:", err);
      }
    }

    // 🚀 **الإشعار التلقائي الفوري الجديد:** إرسال إشعار لجميع المستخدمين في البوت بأن هناك مهمة جديدة أُضيفت!
    const allUsers = await db.getAllUsers();
    for (const u of allUsers) {
      try {
        await ctx.telegram.sendMessage(
          u.telegram_id,
          `🚨 **تنبيه: مهمة جديدة أُضيفت لقائمة المهام!**\n\n` +
            `📋 العنوان: ${data.title}\n` +
            `👥 الأعضاء المطلوبة: ${data.max_members}\n\n` +
            `اضغط على زر (قائمة المهام) في القائمة الرئيسية لاستعراضها وقبولها!`,
        );
      } catch (err) {
        // تجاهل من قاموا بحظر البوت
      }
    }

    return ctx.reply(
      `✅ تم إنشاء المهمة ونشرها وإرسال إشعار فوري لجميع الأعضاء بنجاح.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("📋 عرض قائمة المهام", "tasks_list")],
        backRow(),
      ]),
    );
  }

  if (state.mode === "broadcast" && user.role === "admin") {
    const broadcastText = message.text;
    if (!broadcastText) return ctx.reply("يرجى إرسال نص للإشعار.");

    states.delete(ctx.from.id);
    await ctx.reply("⏳ جاري إرسال الإشعار لجميع المستخدمين...");

    const allUsers = await db.getAllUsers();
    let successCount = 0;
    let failCount = 0;

    for (const u of allUsers) {
      try {
        await ctx.telegram.sendMessage(
          u.telegram_id,
          `📢 **إشعار هامي من إدارة التحقيق:**\n\n${broadcastText}`,
        );
        successCount++;
      } catch (err) {
        failCount++;
      }
    }

    return ctx.reply(
      `✅ **تم الانتهاء من إرسال الإشعار العام:**\n\n` +
        `🎯 تم الإرسال بنجاح إلى: ${successCount} مستخدم\n` +
        `❌ فشل الإرسال إلى (حظروا البوت): ${failCount} مستخدم`,
      Markup.inlineKeyboard(mainMenuRows(true)),
    );
  }

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

  if (ADMIN_GROUP_ID) {
    try {
      let detailsSummary = "";
      if (state.kind === "cases") {
        detailsSummary = `📌 عنوان القضية: ${data.title}\n📝 الوصف: ${data.description || "بدون"}`;
      } else if (state.kind === "independent_accounts") {
        detailsSummary = `🕶️ اسم الحساب: ${data.account_name}\n🔗 الرابط: ${data.account_link}\n👤 المشتبه به: ${data.suspect_name || "بدون"}`;
      } else {
        detailsSummary = `📌 تفاصيل الإضافة مرتبطة بالقضية رقم: ${db.caseNo(state.caseId)}`;
      }

      await ctx.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `🚨 **تم حفظ عنصر جديد بواسطة عضو!**\n\n` +
          `👤 العضو: ${user.name} (@${ctx.from.username || "بدون"})\n` +
          `📂 القسم: ${SINGLE[state.kind]}\n` +
          `🆔 رقم المعرف: #${newId}\n\n` +
          `${detailsSummary}\n\n` +
          `🕒 الوقت والتاريخ: ${new Date().toLocaleString("en-GB")}`,
      );
    } catch (e) {
      console.error("خطأ في إرسال إشعار الحفظ لجروب الأدمنز:", e);
    }
  }

  const target =
    state.kind === "cases"
      ? `case:${newId}`
      : state.kind === "independent_accounts"
        ? `item:independent_accounts:${newId}`
        : `case:${state.caseId}`;
  await ctx.reply(
    `✅ تم حفظ ${SINGLE[state.kind]} بنجاح وتم إبلاغ الإدارة في الجروب.`,
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
  await startHealthServer();
  await db.init();
  await bot.launch();
  console.log("Bot is running with Tasks & Instant Task Notifications...");
})().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});
