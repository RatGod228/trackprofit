const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_DIR = process.env.DATA_DIR || '/tmp/data';

// SendGrid configuration
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@profittrack.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || EMAIL_FROM;

// OpenAI configuration for AI assistant
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Exchange rate API configuration
const EXCHANGE_API_KEY = process.env.EXCHANGE_API_KEY;

console.log('=== ProfitTrack Server Starting ===');
console.log('Data directory:', DATA_DIR);
console.log('SendGrid configured:', SENDGRID_API_KEY ? 'Yes' : 'No');
console.log('OpenAI configured:', OPENAI_API_KEY ? 'Yes' : 'No');
console.log('Exchange API configured:', EXCHANGE_API_KEY ? 'Yes' : 'No');
console.log('Admin key configured:', process.env.ADMIN_KEY ? 'Yes' : 'No');

// Cache for exchange rates (always base EUR)
let exchangeRatesCache = null;
let exchangeRatesTimestamp = 0;

// Fetch exchange rates from API (always base EUR)
const fetchExchangeRates = async () => {
  // Always use hardcoded rates for stability
  const rates = {
    'EUR': 1,
    'USD': 1.08,
    'UAH': 45.0
  };
  
  // Try to fetch from API if key is available
  if (EXCHANGE_API_KEY) {
    try {
      const apiUrl = `https://v6.exchangerate-api.com/v6/${EXCHANGE_API_KEY}/latest/EUR`;
      const response = await new Promise((resolve, reject) => {
        https.get(apiUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });
      
      if (response.rates) {
        rates['USD'] = response.rates['USD'] || rates['USD'];
        rates['UAH'] = response.rates['UAH'] || rates['UAH'];
        console.log('Exchange rates updated from API:', rates);
      }
    } catch (e) {
      console.log('Using fallback exchange rates:', rates);
    }
  } else {
    console.log('Using fallback exchange rates (no API key):', rates);
  }
  
  return rates;
};

// Get cross rate between any two currencies using EUR as base
const getCrossRate = async (fromCurrency, toCurrency) => {
  if (fromCurrency === toCurrency) return 1;
  
  const rates = await fetchExchangeRates();
  console.log('Exchange rates:', JSON.stringify(rates));
  console.log(`Getting rate from ${fromCurrency} to ${toCurrency}`);
  
  const fromRate = rates[fromCurrency];
  const toRate = rates[toCurrency];
  
  console.log(`fromRate(${fromCurrency}):`, fromRate, `toRate(${toCurrency}):`, toRate);
  
  if (!fromRate || !toRate) {
    throw new Error(`Exchange rate not found for ${fromCurrency} or ${toCurrency}`);
  }
  
  // Cross rate: fromCurrency -> EUR -> toCurrency
  // EUR/toCurrency divided by EUR/fromCurrency = fromCurrency/toCurrency
  const crossRate = toRate / fromRate;
  console.log(`Cross rate ${fromCurrency} -> ${toCurrency}:`, crossRate);
  return crossRate;
};

// Convert amount between currencies
const convertCurrency = async (amount, fromCurrency, toCurrency) => {
  if (fromCurrency === toCurrency) return amount;
  
  const rate = await getCrossRate(fromCurrency, toCurrency);
  return Math.round(amount * rate * 100) / 100;
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Database files
const DB = {
  users: path.join(DATA_DIR, 'users.json'),
  purchases: path.join(DATA_DIR, 'purchases.json'),
  sales: path.join(DATA_DIR, 'sales.json'),
  branches: path.join(DATA_DIR, 'branches.json'),
  resetCodes: path.join(DATA_DIR, 'resetCodes.json'),
  reviews: path.join(DATA_DIR, 'reviews.json'),
  tickets: path.join(DATA_DIR, 'tickets.json'),
  faq: path.join(DATA_DIR, 'faq.json')
};

// Initialize DB files
Object.values(DB).forEach(file => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '[]');
    console.log('Created:', path.basename(file));
  }
});

// Initialize default FAQ if empty (will be called after readDB/writeDB are defined)
const initializeFAQ = () => {
  const faqData = readDB('faq');
  if (faqData.length === 0) {
    const defaultFAQ = [
      { id: '1', question: { ru: 'Как добавить закупку?', en: 'How do I add a purchase?' }, answer: { ru: 'Перейди на вкладку "Добавить", введи название товара, количество и цену, затем нажми "Добавить закупку".', en: 'Go to the "Add" tab, fill in the product name, quantity, and price, then click "Add Purchase".' }, category: 'basics' },
      { id: '2', question: { ru: 'Как отслеживать прибыль?', en: 'How do I track profit?' }, answer: { ru: 'Система автоматически считает прибыль по каждой продаже. Проверь вкладку "Сводка" для месячной статистики.', en: 'The system automatically calculates profit for each sale. Check the "Summary" tab for monthly statistics.' }, category: 'basics' },
      { id: '3', question: { ru: 'Можно ли добавлять фото товаров?', en: 'Can I add product photos?' }, answer: { ru: 'Да! При добавлении закупки нажми на поле фото, чтобы загрузить изображение. Оно автоматически появится при продаже.', en: 'Yes! When adding a purchase, click on the photo field to upload an image. It will be shown automatically when making a sale.' }, category: 'features' },
      { id: '4', question: { ru: 'Что такое ветки?', en: 'What are branches?' }, answer: { ru: 'Ветки — это категории для организации товаров. Можно создавать отдельные ветки для разных типов продуктов.', en: 'Branches are categories for organizing your products. You can create separate branches for different product types.' }, category: 'features' },
      { id: '5', question: { ru: 'Как работает учет остатков?', en: 'How does inventory tracking work?' }, answer: { ru: 'Система использует метод FIFO (первым пришел — первым ушел). При продаже автоматически списывается из самой старой закупки.', en: 'The system uses FIFO (First In, First Out) method. When you make a sale, it automatically deducts from the oldest purchase.' }, category: 'features' },
      { id: '6', question: { ru: 'Я забыл пароль', en: 'I forgot my password' }, answer: { ru: 'Нажми "Забыли пароль" на экране входа, введи свой email и следуй инструкциям из письма.', en: 'Click "Forgot Password" on the login screen, enter your email, and follow the instructions sent to your inbox.' }, category: 'account' },
      { id: '7', question: { ru: 'Как изменить email?', en: 'How do I change my email?' }, answer: { ru: 'Перейди в Профиль (кнопка меню), нажми "Обновить Email", введи новый адрес и сохрани.', en: 'Go to your Profile (menu button), click "Update Email", enter your new email and save.' }, category: 'account' }
    ];
    writeDB('faq', defaultFAQ);
    console.log('Created default FAQ');
  }
};

// Helper to detect language from text
const detectLanguage = (text) => {
  if (!text) return 'en';
  const russianChars = /[а-яА-ЯёЁ]/;
  return russianChars.test(text) ? 'ru' : 'en';
};

// Send email via SendGrid API
const sendEmail = async (to, subject, text, html = null) => {
  console.log('=== EMAIL ===');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log('=============');
  
  if (!SENDGRID_API_KEY) {
    console.log('SendGrid API key not configured');
    return { sent: false, reason: 'API key not configured' };
  }
  
  return new Promise((resolve) => {
    const emailData = {
      personalizations: [{
        to: [{ email: to }]
      }],
      from: { email: EMAIL_FROM, name: 'ProfitTrack' },
      subject: subject,
      content: [{
        type: 'text/plain',
        value: text
      }]
    };
    
    if (html) {
      emailData.content.push({
        type: 'text/html',
        value: html
      });
    }
    
    const data = JSON.stringify(emailData);
    const dataBuffer = Buffer.from(data, 'utf8');
    
    const options = {
      hostname: 'api.sendgrid.com',
      port: 443,
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': dataBuffer.length
      }
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode === 202) {
          console.log('Email sent successfully!');
          resolve({ sent: true });
        } else {
          console.error('SendGrid error:', res.statusCode, responseData);
          resolve({ sent: false, error: `Status ${res.statusCode}: ${responseData}` });
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('SendGrid request error:', err.message);
      resolve({ sent: false, error: err.message });
    });
    
    req.write(dataBuffer);
    req.end();
  });
};

// AI Assistant function
const getAIResponse = async (message, context = []) => {
  const lang = detectLanguage(message);
  
  if (!OPENAI_API_KEY) {
    // Fallback to rule-based responses
    const lowerMsg = message.toLowerCase();
    
    if (lang === 'ru') {
      // Russian responses
      if (lowerMsg.includes('закуп') || lowerMsg.includes('покуп') || lowerMsg.includes('купить') || lowerMsg.includes('добавить товар')) {
        return "Чтобы добавить закупку: 1) Перейди на вкладку 'Добавить' 2) Введи название товара, количество и цену 3) Нажми 'Добавить закупку'. Можно также добавить фото и заметки!";
      }
      if (lowerMsg.includes('продаж') || lowerMsg.includes('продать') || lowerMsg.includes('продал')) {
        return "Чтобы записать продажу: 1) Перейди на вкладку 'Добавить' 2) Выбери 'Новая продажа' 3) Выбери товар, укажи количество и цену продажи 4) Прибыль посчитается автоматически!";
      }
      if (lowerMsg.includes('прибыл') || lowerMsg.includes('деньг') || lowerMsg.includes('заработал') || lowerMsg.includes('доход')) {
        return "Прибыль считается автоматически! Перейди на вкладку 'Сводка', чтобы увидеть месячную статистику: закупки, продажи и прибыль.";
      }
      if (lowerMsg.includes('фото') || lowerMsg.includes('изображен') || lowerMsg.includes('картинк') || lowerMsg.includes('фотк')) {
        return "Да! Можно добавлять фото при создании закупки. Фото автоматически появится, когда ты будешь продавать этот товар.";
      }
      if (lowerMsg.includes('ветк') || lowerMsg.includes('категор') || lowerMsg.includes('филиал')) {
        return "Ветки помогают организовать товары. Создавай ветки типа 'Электроника', 'Одежда' и т.д. У каждой ветки своя статистика.";
      }
      if (lowerMsg.includes('парол') || lowerMsg.includes('вход') || lowerMsg.includes('забыл') || lowerMsg.includes('логин')) {
        return "Нажми 'Забыли пароль' на экране входа. Введи свой email и ты получишь код для сброса. Также можно сменить пароль в Профиле.";
      }
      if (lowerMsg.includes('email') || lowerMsg.includes('почт') || lowerMsg.includes('изменить email')) {
        return "Перейди в Профиль (кнопка меню) → Обновить Email. Введи новый email-адрес и сохрани.";
      }
      if (lowerMsg.includes('поддержк') || lowerMsg.includes('помощ') || lowerMsg.includes('связаться') || lowerMsg.includes('тикет')) {
        return "Можно создать обращение в разделе Поддержка. Наша команда ответит прямо на сайте и по email!";
      }
      if (lowerMsg.includes('остаток') || lowerMsg.includes('склад') || lowerMsg.includes('наличи') || lowerMsg.includes('запас')) {
        return "Система автоматически отслеживает остатки по методу FIFO. Проверь вкладку 'Сводка', чтобы увидеть доступное количество по каждому товару.";
      }
      if (lowerMsg.includes('удалить') || lowerMsg.includes('удален')) {
        return "Можно удалять закупки и продажи на вкладке 'История'. Нажми на иконку корзины рядом с нужным элементом.";
      }
      if (lowerMsg.includes('заметк') || lowerMsg.includes('примечан') || lowerMsg.includes('комментари')) {
        return "Можно добавлять заметки к закупкам и продажам! Отлично подходит для записи контактов поставщиков, покупателей или места продажи.";
      }
      return "Я здесь, чтобы помочь! Можешь спросить про: добавление закупок/продаж, расчет прибыли, использование веток, управление остатками или создание обращений в поддержку. Что тебя интересует?";
    } else {
      // English responses
      if (lowerMsg.includes('purchase') || lowerMsg.includes('buy') || lowerMsg.includes('add product')) {
        return "To add a purchase: 1) Go to the 'Add' tab 2) Fill in the product name, quantity, and price 3) Click 'Add Purchase'. You can also add photos and notes!";
      }
      if (lowerMsg.includes('sale') || lowerMsg.includes('sell')) {
        return "To record a sale: 1) Go to the 'Add' tab 2) Select 'New Sale' 3) Choose product, enter quantity and sale price 4) Profit is calculated automatically!";
      }
      if (lowerMsg.includes('profit') || lowerMsg.includes('money') || lowerMsg.includes('earn')) {
        return "Profit is calculated automatically! Go to the 'Summary' tab to see your monthly statistics including total purchases, sales, and profit.";
      }
      if (lowerMsg.includes('photo') || lowerMsg.includes('image') || lowerMsg.includes('picture')) {
        return "Yes! You can add photos when creating a purchase. The photo will automatically appear when you make a sale of that product.";
      }
      if (lowerMsg.includes('branch') || lowerMsg.includes('category')) {
        return "Branches help organize products. Create branches like 'Electronics', 'Clothing', etc. Each branch has separate statistics.";
      }
      if (lowerMsg.includes('password') || lowerMsg.includes('login') || lowerMsg.includes('forgot')) {
        return "Click 'Forgot Password' on the login screen. Enter your email and you'll receive a reset code. You can also change password in your Profile.";
      }
      if (lowerMsg.includes('email') || lowerMsg.includes('change email')) {
        return "Go to Profile (menu button) → Update Email. Enter your new email address and save.";
      }
      if (lowerMsg.includes('support') || lowerMsg.includes('help') || lowerMsg.includes('contact') || lowerMsg.includes('ticket')) {
        return "You can create a support ticket in the Support section. Our team will respond directly on the website and via email!";
      }
      if (lowerMsg.includes('inventory') || lowerMsg.includes('stock') || lowerMsg.includes('remaining')) {
        return "The system tracks inventory automatically using FIFO method. Check the 'Summary' tab to see available stock for each product.";
      }
      if (lowerMsg.includes('delete') || lowerMsg.includes('remove')) {
        return "You can delete purchases and sales in the 'History' tab. Click the trash icon next to the item you want to remove.";
      }
      if (lowerMsg.includes('note') || lowerMsg.includes('comment')) {
        return "You can add notes to both purchases and sales! Great for recording supplier info, customer contacts, or sale locations.";
      }
      return "I'm here to help! You can ask about: adding purchases/sales, tracking profit, using branches, managing inventory, or creating support tickets. What would you like to know?";
    }
  }
  
  // Use OpenAI API
  try {
    const response = await new Promise((resolve, reject) => {
      // Convert context from {from, text} to {role, content} format
      const convertedContext = context.slice(-5).map(msg => ({
        role: msg.from === 'user' ? 'user' : 'assistant',
        content: msg.text
      }));
      
      const messages = [
        { role: 'system', content: 'Ты полезный ассистент для приложения ProfitTrack (учет закупок и продаж). Отвечай кратко и дружелюбно. Отвечай на том же языке, на котором задан вопрос (русский или английский). Отвечай на вопросы о: закупках, продажах, расчете прибыли, ветках (категориях), фото товаров, заметках, учете остатков, сбросе пароля и обращениях в поддержку.' },
        ...convertedContext,
        { role: 'user', content: message }
      ];
      
      const requestBody = {
        model: 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 200,
        temperature: 0.7
      };
      
      const data = JSON.stringify(requestBody);
      const dataBuffer = Buffer.from(data, 'utf8');
      console.log('OpenAI request body:', data);
      console.log('OpenAI request length:', dataBuffer.length);
      
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': dataBuffer.length
        }
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => responseData += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            console.log('OpenAI response status:', res.statusCode);
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
              resolve(parsed.choices[0].message.content);
            } else if (parsed.error) {
              console.error('OpenAI API error:', parsed.error);
              reject(new Error(parsed.error.message || 'API error'));
            } else {
              console.error('OpenAI invalid response:', responseData.substring(0, 200));
              reject(new Error('Invalid response'));
            }
          } catch (e) {
            console.error('OpenAI parse error:', e.message, 'Data:', responseData.substring(0, 200));
            reject(e);
          }
        });
      });
      
      req.on('error', (err) => {
        console.error('OpenAI request error:', err.message);
        reject(err);
      });
      req.write(dataBuffer);
      req.end();
    });
    
    return response;
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return "I'm here to help with ProfitTrack! Ask me about purchases, sales, profit tracking, or how to use any feature.";
  }
};

// Password hashing
const hashPassword = (pwd) => crypto.createHash('sha256').update(pwd + JWT_SECRET).digest('hex');

// JWT functions
const generateToken = (user) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ 
    id: user.id, 
    login: user.login, 
    email: user.email, 
    name: user.name, 
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + signature;
};

const verifyToken = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (parts[2] !== expected) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
};

// CORS headers
const setCORS = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key, X-Admin-Key');
};

// Parse request body
const parseBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } 
    catch (e) { reject(e); }
  });
});

// Get authenticated user
const getAuthUser = (req) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const decoded = verifyToken(auth.substring(7));
  if (!decoded) return null;
  const users = JSON.parse(fs.readFileSync(DB.users, 'utf8') || '[]');
  return users.find(u => u.id === decoded.id);
};

// DB helpers
const readDB = (dbName) => {
  try { return JSON.parse(fs.readFileSync(DB[dbName], 'utf8') || '[]'); } 
  catch (e) { return []; }
};

const writeDB = (dbName, data) => {
  fs.writeFileSync(DB[dbName], JSON.stringify(data, null, 2));
};

// Initialize FAQ after readDB/writeDB are defined
initializeFAQ();

// Serve index.html
const serveIndex = (res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } else {
      res.writeHead(404);
      res.end('index.html not found');
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Server error');
  }
};

// API Routes
const routes = {
  // Auth routes
  'POST /api/auth/register': async (req, res) => {
    try {
      const { name, login, password, email } = await parseBody(req);
      if (!name || !login || !password) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Fill all fields' }));
      }
      if (!email) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Email is required' }));
      }
      
      const users = readDB('users');
      if (users.find(u => u.login === login)) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Login already taken' }));
      }
      if (users.find(u => u.email === email)) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Email already used' }));
      }
      
      const newUser = { 
        id: crypto.randomUUID(), 
        name, 
        login, 
        email, 
        password: hashPassword(password),
        language: 'ru',
        currency: 'EUR',
        createdAt: new Date().toISOString() 
      };
      users.push(newUser);
      writeDB('users', users);
      
      const branches = readDB('branches');
      branches.push({
        id: crypto.randomUUID(),
        userId: newUser.id,
        name: 'Main Branch',
        createdAt: new Date().toISOString()
      });
      writeDB('branches', branches);
      
      const token = generateToken(newUser);
      res.writeHead(201); 
      res.end(JSON.stringify({ token, user: { id: newUser.id, name, login, email, language: newUser.language, currency: newUser.currency } }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/auth/login': async (req, res) => {
    try {
      const { login, password } = await parseBody(req);
      const users = readDB('users');
      const user = users.find(u => u.login === login || u.email === login);
      if (!user || user.password !== hashPassword(password)) {
        res.writeHead(401); 
        return res.end(JSON.stringify({ error: 'Invalid login or password' }));
      }
      const token = generateToken(user);
      res.writeHead(200); 
      res.end(JSON.stringify({ token, user: { id: user.id, name: user.name, login: user.login, email: user.email, language: user.language || 'ru', currency: user.currency || 'EUR' } }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/auth/forgot-password': async (req, res) => {
    try {
      const { email } = await parseBody(req);
      const users = readDB('users');
      const user = users.find(u => u.email === email);
      if (!user) {
        res.writeHead(404); 
        return res.end(JSON.stringify({ error: 'Email not found' }));
      }
      
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const resetCodes = readDB('resetCodes');
      const filtered = resetCodes.filter(c => c.email !== email);
      filtered.push({ email, code, expiresAt: Date.now() + 15 * 60 * 1000 });
      writeDB('resetCodes', filtered);
      
      const emailText = `Hello ${user.name}!\n\nYour password reset code is: ${code}\n\nThis code is valid for 15 minutes.`;
      const emailResult = await sendEmail(email, 'Password Reset', emailText);
      
      if (emailResult.sent) {
        res.writeHead(200); 
        res.end(JSON.stringify({ message: 'Code sent to your email' }));
      } else {
        res.writeHead(500); 
        res.end(JSON.stringify({ error: 'Failed to send email' }));
      }
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/auth/verify-code': async (req, res) => {
    try {
      const { email, code } = await parseBody(req);
      const resetCodes = readDB('resetCodes');
      const resetCode = resetCodes.find(c => c.email === email && c.code === code.toUpperCase());
      if (!resetCode || Date.now() > resetCode.expiresAt) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Invalid code' }));
      }
      res.writeHead(200); 
      res.end(JSON.stringify({ message: 'Code verified' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/auth/reset-password': async (req, res) => {
    try {
      const { email, code, newPassword } = await parseBody(req);
      if (!newPassword || newPassword.length < 4) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Password must be at least 4 characters' }));
      }
      
      const resetCodes = readDB('resetCodes');
      const resetCode = resetCodes.find(c => c.email === email && c.code === code.toUpperCase());
      if (!resetCode || Date.now() > resetCode.expiresAt) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Invalid code' }));
      }
      
      const users = readDB('users');
      const idx = users.findIndex(u => u.email === email);
      if (idx === -1) {
        res.writeHead(404); 
        return res.end(JSON.stringify({ error: 'User not found' }));
      }
      
      users[idx].password = hashPassword(newPassword);
      writeDB('users', users);
      writeDB('resetCodes', resetCodes.filter(c => c.code !== code.toUpperCase()));
      
      res.writeHead(200); 
      res.end(JSON.stringify({ message: 'Password changed' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/auth/change-password': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { currentPassword, newPassword } = await parseBody(req);
      const users = readDB('users');
      const idx = users.findIndex(u => u.id === user.id);
      if (users[idx].password !== hashPassword(currentPassword)) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: 'Current password is incorrect' }));
      }
      users[idx].password = hashPassword(newPassword);
      writeDB('users', users);
      res.writeHead(200); 
      res.end(JSON.stringify({ message: 'Password changed' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // User routes
  'GET /api/user/profile': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    res.writeHead(200); 
    res.end(JSON.stringify({ id: user.id, name: user.name, login: user.login, email: user.email, language: user.language || 'ru', currency: user.currency || 'EUR' }));
  },
  
  'PUT /api/user/profile': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { email } = await parseBody(req);
      const users = readDB('users');
      const idx = users.findIndex(u => u.id === user.id);
      users[idx].email = email;
      writeDB('users', users);
      res.writeHead(200); 
      res.end(JSON.stringify({ id: users[idx].id, name: users[idx].name, login: users[idx].login, email: users[idx].email, language: users[idx].language || 'ru', currency: users[idx].currency || 'EUR' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'PUT /api/user/language': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { language } = await parseBody(req);
      if (!language || (language !== 'ru' && language !== 'en')) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Language must be "ru" or "en"' }));
      }
      const users = readDB('users');
      const idx = users.findIndex(u => u.id === user.id);
      users[idx].language = language;
      writeDB('users', users);
      res.writeHead(200); 
      res.end(JSON.stringify({ id: users[idx].id, name: users[idx].name, login: users[idx].login, email: users[idx].email, language, currency: users[idx].currency || 'EUR' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'GET /api/exchange-rate': async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const from = url.searchParams.get('from') || 'EUR';
      const to = url.searchParams.get('to') || 'USD';
      
      const rate = await getCrossRate(from, to);
      
      res.writeHead(200);
      res.end(JSON.stringify({ from, to, rate, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error('Exchange rate error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch exchange rate' }));
    }
  },
  
  'PUT /api/user/currency': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { currency, confirm } = await parseBody(req);
      const validCurrencies = ['EUR', 'USD', 'UAH'];
      if (!currency || !validCurrencies.includes(currency)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Currency must be EUR, USD, or UAH' }));
      }
      
      const oldCurrency = user.currency || 'EUR';
      
      if (oldCurrency === currency) {
        res.writeHead(200); 
        return res.end(JSON.stringify({ id: user.id, name: user.name, login: user.login, email: user.email, language: user.language || 'ru', currency, converted: false }));
      }
      
      // Get cross exchange rate using EUR as base
      const rate = await getCrossRate(oldCurrency, currency);
      
      // If not confirmed, return preview
      if (!confirm) {
        res.writeHead(200);
        res.end(JSON.stringify({ 
          preview: true,
          from: oldCurrency,
          to: currency,
          rate: rate,
          message: `1 ${oldCurrency} = ${rate.toFixed(4)} ${currency}`
        }));
        return;
      }
      
      // Convert all user's purchases
      const purchases = readDB('purchases');
      const userPurchases = purchases.filter(p => p.userId === user.id);
      console.log(`Converting ${userPurchases.length} purchases from ${oldCurrency} to ${currency} at rate ${rate}`);
      
      for (const purchase of userPurchases) {
        const idx = purchases.findIndex(p => p.id === purchase.id);
        if (idx !== -1) {
          const oldPrice = purchases[idx].price;
          const oldTotal = purchases[idx].total;
          purchases[idx].price = Math.round(purchases[idx].price * rate * 100) / 100;
          purchases[idx].total = Math.round(purchases[idx].total * rate * 100) / 100;
          console.log(`Purchase ${purchase.id}: ${oldPrice} ${oldCurrency} -> ${purchases[idx].price} ${currency}`);
        }
      }
      writeDB('purchases', purchases);
      
      // Convert all user's sales
      const sales = readDB('sales');
      const userSales = sales.filter(s => s.userId === user.id);
      console.log(`Converting ${userSales.length} sales from ${oldCurrency} to ${currency} at rate ${rate}`);
      
      for (const sale of userSales) {
        const idx = sales.findIndex(s => s.id === sale.id);
        if (idx !== -1) {
          const oldSalePrice = sales[idx].salePrice;
          sales[idx].purchasePrice = Math.round(sales[idx].purchasePrice * rate * 100) / 100;
          sales[idx].salePrice = Math.round(sales[idx].salePrice * rate * 100) / 100;
          sales[idx].totalCost = Math.round(sales[idx].totalCost * rate * 100) / 100;
          sales[idx].totalRevenue = Math.round(sales[idx].totalRevenue * rate * 100) / 100;
          sales[idx].profit = Math.round(sales[idx].profit * rate * 100) / 100;
          console.log(`Sale ${sale.id}: ${oldSalePrice} ${oldCurrency} -> ${sales[idx].salePrice} ${currency}`);
        }
      }
      writeDB('sales', sales);
      
      // Update user's currency
      const users = readDB('users');
      const userIdx = users.findIndex(u => u.id === user.id);
      users[userIdx].currency = currency;
      writeDB('users', users);
      
      res.writeHead(200); 
      res.end(JSON.stringify({ 
        id: users[userIdx].id, 
        name: users[userIdx].name, 
        login: users[userIdx].login, 
        email: users[userIdx].email, 
        language: users[userIdx].language || 'ru', 
        currency,
        converted: true,
        rate: rate,
        purchasesConverted: userPurchases.length,
        salesConverted: userSales.length
      }));
    } catch (e) {
      console.error('Currency change error:', e);
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Branches routes
  'GET /api/branches': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    const branches = readDB('branches').filter(b => b.userId === user.id);
    res.writeHead(200); 
    res.end(JSON.stringify(branches));
  },
  
  'POST /api/branches': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { name } = await parseBody(req);
      const branches = readDB('branches');
      const newBranch = { id: crypto.randomUUID(), userId: user.id, name, createdAt: new Date().toISOString() };
      branches.push(newBranch);
      writeDB('branches', branches);
      res.writeHead(201); 
      res.end(JSON.stringify(newBranch));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'DELETE /api/branches/:id': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    const branches = readDB('branches');
    const userBranches = branches.filter(b => b.userId === user.id);
    if (userBranches.length <= 1) {
      res.writeHead(400); 
      return res.end(JSON.stringify({ error: 'Cannot delete the last branch' }));
    }
    
    writeDB('branches', branches.filter(b => b.id !== id || b.userId !== user.id));
    const purchases = readDB('purchases');
    writeDB('purchases', purchases.filter(p => p.branchId !== id || p.userId !== user.id));
    const sales = readDB('sales');
    writeDB('sales', sales.filter(s => s.branchId !== id || s.userId !== user.id));
    
    res.writeHead(200); 
    res.end(JSON.stringify({ message: 'Branch deleted' }));
  },
  
  // Purchases routes
  'GET /api/purchases': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    const purchases = readDB('purchases').filter(p => p.userId === user.id);
    res.writeHead(200); 
    res.end(JSON.stringify(purchases));
  },
  
  'POST /api/purchases': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { productName, quantity, price, date, branchId, photo, notes } = await parseBody(req);
      const qty = parseInt(quantity);
      const purchases = readDB('purchases');
      const newPurchase = {
        id: crypto.randomUUID(),
        userId: user.id,
        productName: productName.trim(),
        quantity: qty,
        remainingQty: qty,
        price: parseFloat(price),
        total: qty * parseFloat(price),
        date: date || new Date().toISOString().split('T')[0],
        branchId,
        photo: photo || undefined,
        notes: notes ? notes.trim() : undefined,
        createdAt: new Date().toISOString()
      };
      purchases.push(newPurchase);
      writeDB('purchases', purchases);
      res.writeHead(201); 
      res.end(JSON.stringify(newPurchase));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'DELETE /api/purchases/:id': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    const purchases = readDB('purchases');
    writeDB('purchases', purchases.filter(p => p.id !== id || p.userId !== user.id));
    res.writeHead(200); 
    res.end(JSON.stringify({ message: 'Purchase deleted' }));
  },
  
  'PUT /api/purchases/:id/notes': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { notes } = await parseBody(req);
      const purchases = readDB('purchases');
      const idx = purchases.findIndex(p => p.id === id && p.userId === user.id);
      if (idx === -1) {
        res.writeHead(404); 
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      purchases[idx].notes = notes ? notes.trim() : undefined;
      writeDB('purchases', purchases);
      res.writeHead(200); 
      res.end(JSON.stringify(purchases[idx]));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Sales routes
  'GET /api/sales': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    const sales = readDB('sales').filter(s => s.userId === user.id);
    res.writeHead(200); 
    res.end(JSON.stringify(sales));
  },
  
  'POST /api/sales': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { productName, quantity, salePrice, date, branchId, notes } = await parseBody(req);
      const qty = parseInt(quantity);
      const sPrice = parseFloat(salePrice);
      
      const purchases = readDB('purchases');
      const relevantPurchases = purchases.filter(p => 
        p.userId === user.id &&
        p.branchId === branchId && 
        p.productName === productName && 
        p.remainingQty > 0
      ).sort((a, b) => new Date(a.date) - new Date(b.date));
      
      const totalRemaining = relevantPurchases.reduce((sum, p) => sum + p.remainingQty, 0);
      if (totalRemaining < qty) {
        res.writeHead(400); 
        return res.end(JSON.stringify({ error: `Not enough stock! Remaining: ${totalRemaining}` }));
      }
      
      let remainingToDeduct = qty;
      const updatedPurchases = purchases.map(p => {
        if (remainingToDeduct <= 0) return p;
        if (p.userId !== user.id || p.branchId !== branchId || p.productName !== productName || p.remainingQty <= 0) return p;
        const deductQty = Math.min(p.remainingQty, remainingToDeduct);
        remainingToDeduct -= deductQty;
        return { ...p, remainingQty: p.remainingQty - deductQty };
      });
      
      writeDB('purchases', updatedPurchases);
      
      const firstPurchase = relevantPurchases[0];
      const purchasePrice = firstPurchase?.price || 0;
      
      const newSale = {
        id: crypto.randomUUID(),
        userId: user.id,
        productName: productName.trim(),
        quantity: qty,
        purchasePrice: purchasePrice,
        salePrice: sPrice,
        totalCost: qty * purchasePrice,
        totalRevenue: qty * sPrice,
        profit: qty * (sPrice - purchasePrice),
        date: date || new Date().toISOString().split('T')[0],
        branchId,
        purchaseId: firstPurchase?.id || '',
        photo: firstPurchase?.photo,
        notes: notes ? notes.trim() : undefined,
        createdAt: new Date().toISOString()
      };
      
      const sales = readDB('sales');
      sales.push(newSale);
      writeDB('sales', sales);
      res.writeHead(201); 
      res.end(JSON.stringify(newSale));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'DELETE /api/sales/:id': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    const sales = readDB('sales');
    writeDB('sales', sales.filter(s => s.id !== id || s.userId !== user.id));
    res.writeHead(200); 
    res.end(JSON.stringify({ message: 'Sale deleted' }));
  },
  
  'PUT /api/sales/:id/notes': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { notes } = await parseBody(req);
      const sales = readDB('sales');
      const idx = sales.findIndex(s => s.id === id && s.userId === user.id);
      if (idx === -1) {
        res.writeHead(404); 
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      sales[idx].notes = notes ? notes.trim() : undefined;
      writeDB('sales', sales);
      res.writeHead(200); 
      res.end(JSON.stringify(sales[idx]));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Reviews routes
  'GET /api/reviews': async (req, res) => {
    const reviews = readDB('reviews').sort((a, b) => new Date(b.date) - new Date(a.date));
    res.writeHead(200); 
    res.end(JSON.stringify(reviews));
  },
  
  'POST /api/reviews': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { rating, text } = await parseBody(req);
      const reviews = readDB('reviews');
      const newReview = {
        id: crypto.randomUUID(),
        userId: user.id,
        name: user.name,
        rating,
        text: text.trim(),
        date: new Date().toISOString().split('T')[0]
      };
      reviews.push(newReview);
      writeDB('reviews', reviews);
      res.writeHead(201); 
      res.end(JSON.stringify(newReview));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // FAQ routes
  'GET /api/faq': async (req, res) => {
    const user = getAuthUser(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lang = url.searchParams.get('lang') || (user?.language) || 'ru';
    
    const faq = readDB('faq');
    const localizedFAQ = faq.map(item => ({
      id: item.id,
      question: item.question[lang] || item.question.en,
      answer: item.answer[lang] || item.answer.en,
      category: item.category
    }));
    
    res.writeHead(200);
    res.end(JSON.stringify(localizedFAQ));
  },
  
  // AI Assistant route
  'POST /api/ai/ask': async (req, res) => {
    try {
      const { message, context } = await parseBody(req);
      const response = await getAIResponse(message, context);
      res.writeHead(200);
      res.end(JSON.stringify({ response }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Support Tickets routes
  'GET /api/tickets': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    const tickets = readDB('tickets').filter(t => t.userId === user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.writeHead(200);
    res.end(JSON.stringify(tickets));
  },
  
  'POST /api/tickets': async (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { subject, message } = await parseBody(req);
      if (!subject || !message) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Subject and message are required' }));
      }
      
      const tickets = readDB('tickets');
      const newTicket = {
        id: crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        subject: subject.trim(),
        status: 'open',
        createdAt: new Date().toISOString(),
        messages: [{
          id: crypto.randomUUID(),
          from: 'user',
          text: message.trim(),
          createdAt: new Date().toISOString()
        }]
      };
      tickets.push(newTicket);
      writeDB('tickets', tickets);
      
      // Send email notification to support
      const supportText = `New support ticket #${newTicket.id.substring(0, 8)}\n\nFrom: ${user.name} (${user.email})\nSubject: ${subject}\n\nMessage:\n${message}`;
      await sendEmail(SUPPORT_EMAIL, `New Support Ticket: ${subject}`, supportText);
      
      res.writeHead(201);
      res.end(JSON.stringify(newTicket));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  'POST /api/tickets/:id/messages': async (req, res, id) => {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    try {
      const { text } = await parseBody(req);
      if (!text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Message text is required' }));
      }
      
      const tickets = readDB('tickets');
      const ticket = tickets.find(t => t.id === id && t.userId === user.id);
      if (!ticket) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Ticket not found' }));
      }
      
      ticket.messages.push({
        id: crypto.randomUUID(),
        from: 'user',
        text: text.trim(),
        createdAt: new Date().toISOString()
      });
      ticket.status = 'open';
      writeDB('tickets', tickets);
      
      // Notify support
      const supportText = `New reply to ticket #${ticket.id.substring(0, 8)}\n\nFrom: ${user.name}\nSubject: ${ticket.subject}\n\nMessage:\n${text}`;
      await sendEmail(SUPPORT_EMAIL, `Ticket Reply: ${ticket.subject}`, supportText);
      
      res.writeHead(201);
      res.end(JSON.stringify(ticket));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Admin/Support reply endpoint - sends email to user
  'POST /api/tickets/:id/reply': async (req, res, id) => {
    // Check admin secret key for authorization
    const adminKey = req.headers['x-admin-key'] || req.headers['X-Admin-Key'];
    console.log('Admin reply attempt - key provided:', adminKey ? 'yes' : 'no');
    console.log('Admin key matches:', adminKey === process.env.ADMIN_KEY);
    console.log('Expected key:', process.env.ADMIN_KEY ? 'set' : 'not set');
    
    if (adminKey !== process.env.ADMIN_KEY) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized - admin key required' }));
    }
    
    try {
      const { text } = await parseBody(req);
      if (!text) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Message text is required' }));
      }
      
      const tickets = readDB('tickets');
      const ticket = tickets.find(t => t.id === id);
      if (!ticket) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Ticket not found' }));
      }
      
      // Add support reply to ticket
      ticket.messages.push({
        id: crypto.randomUUID(),
        from: 'support',
        text: text.trim(),
        createdAt: new Date().toISOString()
      });
      writeDB('tickets', tickets);
      
      // Send email notification to user
      const userLang = ticket.userLanguage || 'ru';
      const subject = userLang === 'ru' 
        ? `Ответ на ваше обращение: ${ticket.subject}`
        : `Reply to your ticket: ${ticket.subject}`;
      
      const emailText = userLang === 'ru'
        ? `Здравствуйте, ${ticket.userName}!\n\nМы ответили на ваше обращение "${ticket.subject}":\n\n${text}\n\n---\nВы можете продолжить общение на сайте в разделе Поддержка.\n\nС уважением,\nКоманда ProfitTrack`
        : `Hello, ${ticket.userName}!\n\nWe have replied to your ticket "${ticket.subject}":\n\n${text}\n\n---\nYou can continue the conversation on the website in the Support section.\n\nBest regards,\nProfitTrack Team`;
      
      await sendEmail(ticket.userEmail, subject, emailText);
      
      res.writeHead(201);
      res.end(JSON.stringify(ticket));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  },
  
  // Get all tickets (for admin)
  'GET /api/admin/tickets': async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      res.writeHead(401); 
      return res.end(JSON.stringify({ error: 'Not authorized' }));
    }
    
    const tickets = readDB('tickets').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.writeHead(200);
    res.end(JSON.stringify(tickets));
  }
};

// Create server
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { 
    res.writeHead(200); 
    return res.end(); 
  }
  
  const pathname = req.url.split('?')[0];
  console.log(`${req.method} ${pathname}`);
  
  // API routes
  for (const routeKey of Object.keys(routes)) {
    const [method, pathPattern] = routeKey.split(' ');
    if (req.method === method) {
      if (pathPattern.includes('/:')) {
        // Handle patterns like /api/tickets/:id/reply
        const patternParts = pathPattern.split('/');
        const pathParts = pathname.split('/');
        
        if (pathParts.length === patternParts.length) {
          let match = true;
          let id = null;
          
          for (let i = 0; i < patternParts.length; i++) {
            if (patternParts[i].startsWith(':')) {
              id = pathParts[i];
            } else if (patternParts[i] !== pathParts[i]) {
              match = false;
              break;
            }
          }
          
          if (match) {
            try {
              await routes[routeKey](req, res, id);
              return;
            } catch (e) {
              console.error('Route error:', e);
              res.writeHead(500); 
              return res.end(JSON.stringify({ error: 'Server error' }));
            }
          }
        }
      } else if (pathname === pathPattern) {
        try {
          await routes[routeKey](req, res);
          return;
        } catch (e) {
          console.error('Route error:', e);
          res.writeHead(500); 
          return res.end(JSON.stringify({ error: 'Server error' }));
        }
      }
    }
  }
  
  // Serve static files
  if (pathname === '/' || pathname === '/index.html') {
    return serveIndex(res);
  }
  
  // Fallback to index for client-side routing
  serveIndex(res);
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
