import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. Load Environment Variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// 2. Middleware
app.use(express.json()); // Parse JSON bodies
app.use(cors());         // Allow React to talk to this server

// 3. Connect to MongoDB
if (!process.env.MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI environment variable is missing!');
}

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
//               DATABASE MODELS
// ==========================================

// --- Company Model ---
const CompanySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  affiliations: [{ type: String }], // Хэлтэс, салбар (e.g., ["HR", "IT", "Sales"])
  positions: [{ type: String }],    // Албан тушаал (e.g., ["Manager", "Developer"])
  createdAt: { type: Date, default: Date.now }
});
const Company = mongoose.model('Company', CompanySchema);

// --- User Model ---
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'student' },
  name: { type: String },
  supervisorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  
  // Company Fields
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null },
  affiliation: { type: String, default: '' },
  position: { type: String, default: '' }
});
const User = mongoose.model('User', UserSchema);

// --- Inquiry Model (Contact Form) ---
const InquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String, required: true },
  date: { type: Date, default: Date.now }
});
const Inquiry = mongoose.model('Inquiry', InquirySchema);

// --- Test Result Model (History) ---
const TestResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: Date, default: Date.now },
  overallScore: { type: Number }, // Average score (0-100)
  overallData: { type: Array },   // Data for Spider Chart
  detailsData: { type: Object }   // Data for Bar Charts
});
const TestResult = mongoose.model('TestResult', TestResultSchema);


// ==========================================
//           SECURITY MIDDLEWARE
// ==========================================

// 1. Verify JWT Token (Checks if the user is logged in)
const verifyToken = (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader && authHeader.split(' ')[1]; // Expects "Bearer <token>"

  if (!token) {
    return res.status(401).json({ message: 'Хандах эрхгүй байна. Токен байхгүй.' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified; // Attach user info (id, role) to the request
    next();
  } catch (err) {
    res.status(403).json({ message: 'Токений хугацаа дууссан эсвэл буруу байна.' });
  }
};

// 2. Role-Based Access Control (Checks if the user has the right role)
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Энэ үйлдлийг хийх эрх танд байхгүй байна.' });
    }
    next();
  };
};

// Helper: AI Request Retry Wrapper for temporary 503 / 429 overloads
async function generateAIContentWithRetry(model, prompt, maxRetries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      if ((error.status === 503 || error.status === 429) && attempt < maxRetries) {
        console.warn(`Gemini API busy (status ${error.status}). Retrying in ${delayMs * attempt}ms... (Attempt ${attempt}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        continue;
      }
      throw error;
    }
  }
}


// ==========================================
//                 API ROUTES
// ==========================================

// --- PUBLIC ROUTES (No Token Needed) ---

// 1. LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Өгөгдлийн сантай холбогдож чадсангүй. Түр хүлээнэ үү.' });
  }

  if (!process.env.JWT_SECRET) {
    console.error('❌ FATAL: JWT_SECRET environment variable is missing!');
    return res.status(500).json({ message: 'Серверийн тохиргооны алдаа (JWT_SECRET байхгүй).' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Хэрэглэгч олдсонгүй' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Нууц үг буруу байна' });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ 
      token, 
      user: { id: user._id, name: user.name, role: user.role } 
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. SUBMIT INQUIRY (Contact Form)
app.post('/api/inquiry', async (req, res) => {
  try {
    const newInquiry = new Inquiry(req.body);
    await newInquiry.save();
    res.json({ message: 'Зурвас амжилттай илгээгдлээ!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- PROTECTED ADMIN ROUTES ---

// REGISTER USER (Admin Only)
app.post('/api/register', verifyToken, requireRole(['admin']), async (req, res) => {
  const { email, password, name, role, supervisorId, companyId, affiliation, position } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'Хэрэглэгчийн имэйл бүртгэлтэй байна' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      email,
      password: hashedPassword,
      name,
      role,
      supervisorId: role === 'student' ? supervisorId : null,
      companyId: companyId || null,
      affiliation: affiliation || '',
      position: position || ''
    });

    await newUser.save();
    res.json({ message: 'Хэрэглэгч амжилттай бүртгэгдлээ!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COMPANY MANAGEMENT (Admin Only) ---

// Create a new Company
app.post('/api/companies', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const newCompany = new Company(req.body);
    await newCompany.save();
    res.json({ message: 'Компани амжилттай бүртгэгдлээ!' });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'Энэ нэртэй компани бүртгэлтэй байна.' });
    res.status(500).json({ error: err.message });
  }
});

// Get all Companies
app.get('/api/companies', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET ALL USERS (Admin Only)
app.get('/api/users', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const users = await User.find()
      .select('-password')
      .populate('supervisorId', 'name')
      .populate('companyId', 'name')
      .sort({ _id: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE USER (Admin Only)
app.delete('/api/users/:id', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Хэрэглэгч амжилттай устгагдлаа' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET INQUIRIES (Admin Only)
app.get('/api/inquiries', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const messages = await Inquiry.find().sort({ date: -1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- PROTECTED SUPERVISOR & ADMIN ROUTES ---

// GET LIST OF SUPERVISORS (For Dropdowns)
app.get('/api/supervisors-list', verifyToken, requireRole(['admin', 'supervisor']), async (req, res) => {
  try {
    const supervisors = await User.find({ role: 'supervisor' }).select('name _id');
    res.json(supervisors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET MY EMPLOYEES (Supervisor Only)
app.get('/api/my-employees/:supervisorId', verifyToken, requireRole(['supervisor']), async (req, res) => {
  try {
    const employees = await User.find({ supervisorId: req.params.supervisorId }).select('-password');
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI TEAM RECOMMENDATION ROUTE (Supervisor Only) ---
app.post('/api/generate-team-advice', verifyToken, requireRole(['supervisor', 'admin']), async (req, res) => {
  const { teamStats } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY тохируулагдаагүй байна.' });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
      Та бол байгууллагын хүний нөөц, манлайллын чиглэлээр мэргэшсэн ментор юм. 
      Нэгэн багийн нийт ажилтнуудын тестийн нэгтгэсэн үзүүлэлт (дундаж оноо болон хамгийн сайн/сул талууд) дараах байдалтай гарлаа:
      
      ${JSON.stringify(teamStats, null, 2)}
      
      Уг багийн удирдагчид зориулан багийн давуу болон сул талыг дүгнэж, цаашид багаа хэрхэн чиглүүлэх, ямар сургалт хөгжлийн хөтөлбөр хэрэгжүүлэх талаар 1 цогц, маш мэргэжлийн, монгол хэлээр зөвлөмж бичиж өгнө үү. Урт нь 5-6 өгүүлбэр байхад хангалттай.
    `;

    const result = await generateAIContentWithRetry(model, prompt);
    res.json({ advice: result.response.text() });
  } catch (error) {
    console.error("Team AI Error:", error);
    res.status(500).json({ error: 'Хиймэл оюунтай холбогдоход алдаа гарлаа.' });
  }
});

// --- INDIVIDUAL AI RECOMMENDATION ROUTE (Supervisor Only) ---
app.post('/api/generate-advice', verifyToken, requireRole(['supervisor', 'admin']), async (req, res) => {
  const { employeeName, detailsData } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY тохируулагдаагүй байна.' });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
      Та бол хүний нөөцийн ментор. 
      Ажилтан ${employeeName}-ийн ур чадварын дэлгэрэнгүй үзүүлэлт:
      ${JSON.stringify(detailsData, null, 2)}
      
      Энэхүү дата дээр үндэслэн ажилтны давуу тал болон сайжруулах шаардлагатай зүйлс дээр мэргэжлийн, урам зориг өгсөн 4-5 өгүүлбэртэй зөвлөмжийг монгол хэлээр бичиж өгнө үү.
    `;

    const result = await generateAIContentWithRetry(model, prompt);
    res.json({ advice: result.response.text() });
  } catch (error) {
    console.error("Individual AI Error:", error);
    res.status(500).json({ error: 'Хиймэл оюунтай холбогдоход алдаа гарлаа.' });
  }
});


// --- GENERAL LOGGED-IN USER ROUTES ---

// SAVE TEST RESULT (Any logged-in user)
app.post('/api/test-results', verifyToken, async (req, res) => {
  try {
    const { userId, overallData, detailsData } = req.body;
    
    const sum = overallData.reduce((acc, item) => acc + item.A, 0);
    const avg = Math.round(sum / overallData.length);

    const newResult = new TestResult({
      userId,
      overallScore: avg,
      overallData,
      detailsData
    });

    await newResult.save();
    res.json({ message: 'Үр дүн амжилттай хадгалагдлаа!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET HISTORY FOR A USER (Any logged-in user)
app.get('/api/test-results/:userId', verifyToken, async (req, res) => {
  try {
    const results = await TestResult.find({ userId: req.params.userId }).sort({ date: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
//               START SERVER
// ==========================================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
