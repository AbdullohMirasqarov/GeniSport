# GeniSport 2.0

GeniSport kamerada push-up, squat va pull-up takrorlarini hisoblaydi. Yakka mashg‘ulotlar va ikki kishilik jonli duellar bitta veb-ilovada ishlaydi. Interfeys ingliz tilida.

## Windows’da ishga tushirish

1. ZIP’ni to‘liq alohida papkaga oching. Python 3.11 yoki 3.12 va Windows Python Launcher (py) o‘rnatilgan bo‘lsin.
2. GeniSport papkasida **start-windows.bat** faylini oching. Birinchi ishga tushirishda Python paketlarini yuklash uchun internet kerak.
3. Terminalda server manzili chiqqach, brauzerda **http://127.0.0.1:8000** ni oching. Server ishlayotgan paytda terminal ochiq tursin. To‘xtatish uchun Ctrl+C bosing.

Linux / macOS uchun, loyiha papkasida:

~~~bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
~~~

## Mashg‘ulot

Train bo‘limida mashq va kamerani tanlang. Start tugmasini bosib kamera ruxsatini bering. MediaPipe modeli, WebAssembly va tana nuqtalarini aniqlash fayllari static/vendor/pose ichida, brauzer ularni shu serverdan oladi. Video va tana koordinatalari qurilmada qayta ishlanadi.

- **Push-ups** — kameraga yon tomondan turib, yelka, tirsak, bilak va sonni kadrda tuting. Hisoblagich gorizontal holatdagi tirsak burchagini kuzatadi.
- **Squats** — yon tomondan son, tizza va to‘piq ko‘rinsin. Tizzani bukish va qayta yozish bitta takror bo‘ladi.
- **Pull-ups** — turnikda qo‘llar yelkadan yuqorida ko‘rinsin. Hisoblagich osilgan holatdan tirsakni bukib, qayta yozish siklini taniydi. Turnikka iyak tekkanini yoki tayanchdagi vaznni aniqlamaydi.

Uch soniyalik tayyorgarlikdan so‘ng vaqt va hisob boshlanadi. Target maydoniga takrorlar sonini kiritsangiz, maqsadga yetganda mashq to‘xtaydi. Stop bosilganda davomiylik muzlatiladi. **Save workout** serverga yozadi. To‘xtatilgan mashqning saqlanmagan natijasi shu brauzerda foydalanuvchi va mashq turi bo‘yicha tiklanadi. Kaloriya MET, vazn va mashq davomiyligidan hisoblangan taxminiy qiymat.

## Duellar va statistika

Battle → mashq → Time Attack yoki Target Race → Create room. Xona kodini yoki taklif havolasini ikkinchi foydalanuvchiga bering. Ikkala o‘yinchi Ready bosganda server umumiy sanoqni boshlaydi. Vaqt tugaganda ko‘proq takror, poygada esa maqsadga birinchi yetish g‘alaba beradi. Faol dueldan chiqish mag‘lubiyat sifatida qayd etiladi. Yakunda revansh ochish mumkin.

My Stats yakka mashg‘ulotlar jami, oxirgi yetti kun, har bir mashqdagi eng yaxshi sessiya, sahifalanadigan tarix va so‘nggi o‘nta duelni ko‘rsatadi. Download CSV orqali barcha yakka mashg‘ulotlarni jadvalga yuklab olish mumkin. Leaderboard saqlangan yakka mashg‘ulotlar bo‘yicha kunlik (UTC) va umumiy top-10 ni chiqaradi. Duel natijalari alohida yuritiladi. Hisoblar ishtirokchilarning brauzeridan keladi.

## Telefonga ilova kabi o‘rnatish

GeniSport APK emas, linkdan o‘rnatiladigan web app (PWA). Saytingizni Android Chrome’da yoki iOS Safari’da HTTPS manzilda oching. Sayt bir marta to‘liq yuklanishini kuting. **Install app** tugmasi chiqsa bosing. iPhone’da **Share → Add to Home Screen** ni tanlang. Chrome menyusida **Install app** yoki **Add to Home Screen** ko‘rinishi mumkin. Ilova bosh ekran belgisi orqali alohida oynada ochiladi.

Ilova qobig‘i, JavaScript va MediaPipe fayllari birinchi tashrifda qurilmada keshlanadi. Kamera modeli ilk marta yuklanayotganda internet kerak. SQLite bazasi serverda turadi. Aloqa uzilganda ilova ochilishi va kameradagi hisoblagich davom etishi mumkin, ammo login, saqlash va duel internetni talab qiladi.

## Render’ga bepul joylash va SQLite backup

Render Free 15 daqiqa kiruvchi HTTP yoki WebSocket trafigi bo‘lmasa serverni uyquga qo‘yadi. Tashqi monitor har 5 daqiqada /health manziliga so‘rov yuborsa, server faol qoladi. Render hujjatlariga ko‘ra /robots.txt so‘rovi hisobga olinmaydi. UptimeRobot Free rejasi 5 daqiqalik intervalni beradi. Bitta service oyiga 750 bepul soat ishlatadi. Boshqa service’lar ham shu workspace limitidan foydalanadi. Render restart qilishi mumkin. Shuning uchun SQLite nusxalari alohida shaxsiy Telegram chatga yuboriladi.

### Render Blueprint

1. GeniSport ZIP’ni ochib, loyiha ichidagi fayllarni GitHub repository’ga yuklang.
2. Render’da New → Blueprint ni tanlab, repository’ni ulang. render.yaml yangi Free web service yaratadi.
3. Deploy tugagach, Render Environment bo‘limida BACKUP_BOT_TOKEN va BACKUP_CHAT_ID qiymatlarini kiriting. GENISPORT_SECRET_KEY va RESTORE_KEY avtomatik hosil bo‘ladi. Ularni parol menejerida saqlang.
4. Bot tokenini Telegram’da BotFather’dan oling. Botga shaxsiy akkauntingizdan /start yuboring. Chat ID’ingizni Telegram ID ko‘rsatuvchi botdan aniqlang. Backup bot faqat shu private chatga fayl yuboradi. Guruh yoki umumiy kanal ID’sini bermang.
5. UptimeRobot’da HTTP(s) monitor yarating. Bepul 5 daqiqalik tekshiruvni https://SIZNING-SERVICE.onrender.com/health manziliga qo‘ying. Bu endpoint database’ga ulanmaydi.
6. Render HTTPS havolasini telefonda ochib GeniSport’ni o‘rnating. MediaPipe modeli ilk kamerali mashg‘ulotda yuklanadi.

### Backup va tiklash

Server ishga tushganda backup darhol yuboriladi, keyin har kuni Toshkent vaqti bilan yarim tunda yuboriladi. Backup BACKUP_BOT_TOKEN va BACKUP_CHAT_ID ikkalasi sozlangan bo‘lsa ishlaydi. Render restart qilsa, keyingi ishga tushishda yana nusxa yuboradi. Backup ichida foydalanuvchi nomlari, parol hash’lari, mashg‘ulotlar va duellar bo‘ladi. Uni shaxsiy chatda saqlang.

Ma’lumotlarni tiklash uchun Telegram’dan SQLite faylini kompyuterga yuklab oling. Render Environment’dan RESTORE_KEY’ni oling, so‘ng quyidagi buyrug‘ni bajaring. Windows PowerShell’da ham ishlaydi. Kalitni boshqalarga yubormang.

~~~bash
curl -X POST https://SIZNING-SERVICE.onrender.com/admin/database/restore -H "X-Backup-Restore-Key: SIZNING_RESTORE_KEY" -F "backup=@genisport-backup-YYYY-MM-DD.sqlite3"
~~~

Muvaffaqiyatli javob {"status":"restored"} bo‘ladi. Endpoint restore key’siz fayl qabul qilmaydi, SQLite’ni tekshiradi, faqat GeniSport backup’ini tiklaydi. Taqdim qilinayotgan SQLite baza ichida test foydalanuvchi ma’lumotlari yo‘q.

Render sozlamalari, backup va tiklash kodi loyiha ichida. Live service hali yaratilmagan. GitHub, Render va Telegram akkauntlariga ulanish kerak bo‘ladi.

## Docker


Docker ilovani bitta serverda ishga tushiradi. Restartdan keyin bazani saqlash uchun volume ulang. SQLite umumiy tarmoq storage emas.

~~~bash
docker build -t genisport .
docker run --name genisport -d -p 127.0.0.1:8000:8000 -v genisport-data:/data genisport
~~~

Docker yangi bazadan boshlaydi. Lokal ishga tushirishda baza loyiha papkasidagi genisport.db faylida saqlanadi. Serverda GENISPORT_SECRET_KEY qiymatini o‘zgartirmang. Kalit o‘zgarsa, barcha tokenlar yaroqsiz bo‘ladi, foydalanuvchilar qayta kiradi. Startup uchta mashq turini seed qiladi.

## Tekshirish

API hujjatlari serverdagi /docs manzilida. Python testlari uchun python -m pip install httpx buyrug‘ini bajaring. Node.js faqat detektor testini bajarishga kerak.

~~~bash
python tests/test_workouts.py
python tests/test_battle.py
node tests/test_pose.cjs
~~~

Trening API testi alohida vaqtinchalik baza yaratadi. Duel testi ham standart holatda vaqtinchalik bazadan foydalanadi. Kamera uchun yon tomondan to‘liq kadr, yaxshi yoritilgan joy va WebGL’li brauzer kerak. Real harakatni aniqlash sifati rakurs, yorug‘lik va ko‘rinib turgan tana nuqtalariga bog‘liq.

Ilova dastlabki loyiha kabi MIT litsenziyasida. MediaPipe Pose to‘plami @mediapipe/pose 0.5.1675469404 versiyasidan olingan. Litsenziya va paket ma’lumotlari static/vendor/pose ichida.
