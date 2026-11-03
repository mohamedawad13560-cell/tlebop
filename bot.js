// بوت تيليجرام لقسم التحقيق: قضايا، مشتبه بهم، أدلة، تقارير، وبحث
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN مفقود في ملف .env");
// اختياري: لتقييد البوت بمعرّفات محددة (مفصولة بفاصلة). اتركه فارغاً ليعمل للجميع
const ALLOWED = new Set(
  (process.env.ALLOWED_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

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
// حقول اختيارية يمكن تخطيها بكتابة: تخطي
const OPTIONAL = new Set(["fake_account"]);

// خطوات الإدخال لكل قسم: [اسم الحقل، السؤال]
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

const states = new Map(); // userId -> حالة الإدخال أو البحث الحالية
const bot = new Telegraf(TOKEN);

// ---------- الصلاحيات ----------
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  // إذا كانت ALLOWED_IDS فارغة يعمل البوت للجميع بدون قيود
  if (!ALLOWED.size || ALLOWED.has(ctx.from.id)) return next();
  const text = `⛔ غير مصرّح لك باستخدام هذا البوت.\nمعرّفك: ${ctx.from ? ctx.from.id : "?"}`;
  if (ctx.callbackQuery) return ctx.answerCbQuery(text, { show_alert: true });
  if (ctx.message) return ctx.reply(text);
});

// ---------- أدوات العرض ----------
const fmtDate = (d) => new Date(d).toLocaleString("en-GB");

function itemTitle(kind, r) {
  if (kind === "cases") return `${db.caseNo(r.id)} | ${r.title}`;
  if (kind === "suspects") return `${r.name} (${db.caseNo(r.case_id)})`;
  if (kind === "evidence")
    return `دليل #${r.id}: ${(r.description || "").slice(0, 30)}`;
  if (kind === "accounts")
    return `${r.platform}: ${r.username} (${db.caseNo(r.case_id)})`;
  return `${r.title} (${db.caseNo(r.case_id)})`;
}

const itemCb = (kind, r) =>
  kind === "cases" ? `case:${r.id}` : `item:${kind}:${r.id}`;

async function itemText(kind, r) {
  const meta = `\n\n🕒 ${fmtDate(r.created_at)}\n✍️ ${r.created_by}`;
  if (kind === "cases") {
    const n = await db.countByCase(r.id);
    return (
      `📁 ${db.caseNo(r.id)} — ${r.title}\nالحالة: ${r.status}\n\n${r.description || ""}\n\n` +
      `👤 مشتبه بهم: ${n.suspects} | 🧾 أدلة: ${n.evidence} | 📝 تقارير: ${n.reports} | 🕶️ حسابات مشبوهة: ${n.accounts}${meta}`
    );
  }
  const caseLine = `القضية: ${db.caseNo(r.case_id)}\n`;
  if (kind === "suspects") {
    return `👤 ${r.name}\n${caseLine}🎭 الحساب الوهمي: ${r.fake_account || "غير محدد"}\n\n${r.details || ""}${meta}`;
  }
  if (kind === "accounts") {
    return `🕶️ حساب مشبوه #${r.id}\n${caseLine}المنصة: ${r.platform}\nالحساب: ${r.username}\n\n${r.details || ""}${meta}`;
  }
  if (kind === "evidence") {
    return `🧾 دليل #${r.id}\n${caseLine}${r.file_id ? "📎 يوجد مرفق" : "بدون مرفق"}\n\n${r.description}${meta}`;
  }
  return `📝 ${r.title}\n${caseLine}\n${r.body || ""}${meta}`;
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
  const kb = Markup.inlineKeyboard(rows);
  const body = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(body, kb);
    } catch (e) {
      if (!/not modified/i.test(e.message)) throw e;
    }
  } else {
    await ctx.reply(body, kb);
  }
}

const showMenu = (ctx) =>
  show(ctx, "🕵️ بوت قسم التحقيق\nاختر القسم:", mainMenuRows());

async function showList(ctx, kind, caseId) {
  const rows = await db.list(kind, caseId);
  const buttons = rows.map((r) => [
    Markup.button.callback(itemTitle(kind, r), itemCb(kind, r)),
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
  const head = LABELS[kind] + (caseId ? ` — ${db.caseNo(caseId)}` : "");
  await show(
    ctx,
    head + (rows.length ? "" : "\n\nلا توجد سجلات بعد."),
    buttons,
  );
}

async function showCase(ctx, id) {
  const r = await db.get("cases", id);
  if (!r) return show(ctx, "القضية غير موجودة.", [backRow()]);
  const toggle =
    r.status === "مفتوحة" ? "🔒 إغلاق القضية" : "🔓 إعادة فتح القضية";
  await show(ctx, await itemText("cases", r), [
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
  const r = await db.get(kind, id);
  if (!r) return show(ctx, "السجل غير موجود.", [backRow()]);
  await show(ctx, await itemText(kind, r), [
    backRow(`list:${kind}:${r.case_id}`),
  ]);
  if (kind === "evidence" && r.file_id) {
    const senders = {
      photo: "replyWithPhoto",
      video: "replyWithVideo",
      voice: "replyWithVoice",
      audio: "replyWithAudio",
      document: "replyWithDocument",
    };
    await ctx[senders[r.file_type] || "replyWithDocument"](r.file_id);
  }
}

// ---------- الأوامر ----------
bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  await showMenu(ctx);
});
bot.command("cancel", async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply("تم الإلغاء.", Markup.inlineKeyboard(mainMenuRows()));
});

// ---------- الأزرار ----------
bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery();
  const [act, a, b] = ctx.callbackQuery.data.split(":");
  const uid = ctx.from.id;
  states.delete(uid);

  if (act === "menu") return showMenu(ctx);
  if (act === "list") return showList(ctx, a, Number(b));
  if (act === "case") return showCase(ctx, Number(a));
  if (act === "item") return showItem(ctx, a, Number(b));
  if (act === "toggle") {
    const r = await db.get("cases", Number(a));
    if (r) await db.setStatus(r.id, r.status === "مفتوحة" ? "مغلقة" : "مفتوحة");
    return showCase(ctx, Number(a));
  }
  if (act === "new") {
    states.set(uid, {
      mode: "new",
      kind: a,
      caseId: Number(b),
      step: 0,
      data: {},
    });
    return ctx.editMessageText(
      `➕ ${SINGLE[a]} جديد\n\n${STEPS[a][0][1]}\n\n(/cancel للإلغاء)`,
    );
  }
  if (act === "search") {
    states.set(uid, { mode: "search" });
    return ctx.editMessageText(
      "🔍 اكتب كلمة البحث (اسم، رقم قضية، وصف...)\n\n(/cancel للإلغاء)",
    );
  }
});

// ---------- الرسائل (إدخال البيانات والبحث) ----------
function extractFile(msg) {
  if (msg.photo) return [msg.photo[msg.photo.length - 1].file_id, "photo"];
  for (const t of ["document", "video", "voice", "audio"])
    if (msg[t]) return [msg[t].file_id, t];
  return [null, null];
}

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (msg.text && msg.text.startsWith("/")) return; // أوامر غير معروفة
  const st = states.get(ctx.from.id);
  if (!st) return showMenu(ctx);

  if (st.mode === "search") {
    const text = (msg.text || "").trim();
    if (!text) return ctx.reply("اكتب نصاً للبحث.");
    states.delete(ctx.from.id);
    const results = await db.search(text);
    const buttons = results.map(([k, r]) => [
      Markup.button.callback(`${SINGLE[k]}: ${itemTitle(k, r)}`, itemCb(k, r)),
    ]);
    buttons.push(backRow());
    const head = results.length
      ? `نتائج البحث عن «${text}»: ${results.length}`
      : `لا نتائج لـ «${text}»`;
    return ctx.reply(head, Markup.inlineKeyboard(buttons));
  }

  // mode === 'new'
  const steps = STEPS[st.kind];
  const [field] = steps[st.step];
  if (field === "file") {
    const [fileId, fileType] = extractFile(msg);
    if (fileId) {
      st.data.file_id = fileId;
      st.data.file_type = fileType;
    } else if ((msg.text || "").trim() !== "تخطي") {
      return ctx.reply("أرسل ملفاً أو صورة، أو اكتب: تخطي");
    }
  } else {
    if (!msg.text) return ctx.reply("أرسل نصاً من فضلك.");
    const val = msg.text.trim();
    st.data[field] = OPTIONAL.has(field) && val === "تخطي" ? null : val;
  }

  st.step += 1;
  if (st.step < steps.length) return ctx.reply(steps[st.step][1]);

  const data = { ...st.data };
  if (st.kind !== "cases") data.case_id = st.caseId;
  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ");
  const newId = await db.add(st.kind, name, data);
  states.delete(ctx.from.id);
  const target = st.kind === "cases" ? `case:${newId}` : `case:${st.caseId}`;
  await ctx.reply(
    `✅ تم حفظ ${SINGLE[st.kind]} بنجاح.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📂 فتح القضية", target)],
      backRow(),
    ]),
  );
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("⚠️ حدث خطأ غير متوقع، حاول مرة أخرى.").catch(() => {});
});

(async () => {
  if (!ALLOWED.size)
    console.log("ALLOWED_IDS فارغ: البوت مفتوح لجميع المستخدمين.");
  await db.init();
  await bot.launch();
  console.log("Bot is running...");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
