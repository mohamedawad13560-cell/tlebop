# بوت قسم التحقيق

بوت تيليجرام لإدارة القضايا والمشتبه بهم والأدلة والتقارير والحسابات المشبوهة. مبني باستخدام Node.js وTelegraf وMySQL.

## المتطلبات

- Node.js 18 أو أحدث
- MySQL 8 أو متوافق
- رمز بوت تيليجرام من [@BotFather](https://t.me/BotFather)

## الإعداد والتشغيل

1. أنشئ قاعدة البيانات:

   ```sql
   CREATE DATABASE investigation
     CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci;
   ```

2. انسخ `.env.example` إلى `.env`، ثم أدخل رمز البوت وبيانات اتصال MySQL.
3. ثبّت الحزم وشغّل البوت:

   ```bash
   npm install
   npm start
   ```

ينشئ البوت الجداول تلقائياً عند التشغيل الأول. يجب أن يملك مستخدم MySQL صلاحية إنشاء الجداول وتعديلها.

## النشر على منصة تستقبل HTTP

- أمر البناء: `npm ci`
- أمر التشغيل: `npm start`
- أضف متغيرات البيئة المطلوبة أدناه في إعدادات المنصة، واستخدم عنوان MySQL يمكن الوصول إليه من التطبيق.
- إذا كانت المنصة تتطلب منفذًا لفحص الخدمة، مرّر متغير `PORT` الذي توفره المنصة؛ يستمع التطبيق على هذا المنفذ على المسارين `/` و`/health` بعد نجاح اتصال قاعدة البيانات وبدء البوت.
- البوت يستخدم Telegram polling؛ لا تضبط webhook للبوت بالتزامن معه.

## متغيرات البيئة

| المتغير | الوصف |
| --- | --- |
| `BOT_TOKEN` | رمز البوت من BotFather (مطلوب) |
| `ADMIN_TELEGRAM_ID` | معرّف Telegram الرقمي للمشرف (اختياري) |
| `DB_HOST` | عنوان خادم MySQL (الافتراضي `localhost`) |
| `DB_PORT` | منفذ MySQL (الافتراضي `3306`) |
| `DB_USER` | مستخدم MySQL (الافتراضي `root`) |
| `DB_PASSWORD` | كلمة مرور MySQL |
| `DB_NAME` | اسم قاعدة البيانات (الافتراضي `investigation`) |

## رفع المشروع إلى GitHub

ملف `.gitignore` يستثني `.env` و`node_modules` من Git. لا ترفع رمز البوت أو كلمات المرور؛ ارفع `.env.example` فقط كقالب.

بعد إنشاء مستودع فارغ على GitHub، نفّذ من مجلد المشروع:

```bash
git init
git add .
git status
git commit -m "Initial project setup"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

استبدل `USERNAME/REPOSITORY` بعنوان مستودعك. راجع مخرجات `git status` قبل الـ commit للتأكد من عدم ظهور `.env`.

## الملفات الرئيسية

- `bot.js`: أوامر البوت، الواجهة، إدخال البيانات، البحث والصلاحيات.
- `db.js`: الاتصال بـ MySQL وإنشاء الجداول وعمليات القراءة والكتابة.
- `package.json` و`package-lock.json`: تعريف الحزم وإصداراتها.
