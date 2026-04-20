import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const corsOptions = {
  origin: function (origin, callback) {
    const allowed = [process.env.FRONTEND_URL, 'http://localhost:5173'];
    if (!origin || allowed.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Mock Database (Simulating PostgreSQL/Firebase) ---
const db = {
  users: [
    { id: 1, email: 'admin@nexhr.com', password: 'password123', role: 'admin', name: 'Admin User' },
    { id: 2, email: 'employee@nexhr.com', password: 'password123', role: 'employee', name: 'John Employee', baseSalary: 5000, currentSalary: 5000, penalties: [] },
  ],
  attendance: [],
  settings: {
    officeStartTime: '09:00',
    requiredHours: 8,
    halfDayHours: 4,
    lateToleranceMins: 15,
    latePenalty: 15,
    earlyCheckoutPenalty: 15,
    halfDayPenalty: 50,
    fullDayPenalty: 100
  }
};

// --- Google Sheets Sync ---
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const syncToGoogleSheets = async (sheetName, valuesArray) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      console.log(`[Google Sheets Mock] Synced data to sheet (${sheetName}):`, JSON.stringify(valuesArray));
      return;
    }
    const sheets = google.sheets({ version: 'v4', auth });
    
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`, 
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [valuesArray] },
    });
    console.log(`[Google Sheets] Synced row to ${sheetName} successfully!`);
  } catch (err) {
    console.error(`[Google Sheets API Error] Failed to sync to ${sheetName}:`, err.message);
  }
};

// --- Penalty Execution Engine ---
const applyPenalty = async (userId, penaltyAmount, reason) => {
  const user = db.users.find(u => u.id === userId);
  if (!user) return;
  
  user.currentSalary -= penaltyAmount;
  user.penalties.push({ amount: penaltyAmount, reason, date: new Date().toISOString().split('T')[0] });
  
  // Penalties: Date, EmployeeID, Type, Amount, Reason
  await syncToGoogleSheets('Penalties', [
    new Date().toISOString().split('T')[0],
    userId,
    'Deduction',
    penaltyAmount,
    reason
  ]);
  
  // 3. Payroll Sheet Update
  const payrollRecord = [
    userId, 
    user.name, 
    user.baseSalary, 
    user.currentSalary, 
    user.baseSalary - user.currentSalary
  ];
  await syncToGoogleSheets('Payroll', payrollRecord);
};

// --- Authentication Middleware ---
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// --- ROUTES ---

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email === email && u.password === password);
  
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });
  
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '1d' });
  
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });
});

// Admin Settings
app.get('/api/admin/settings', authenticate, (req, res) => {
  res.json(db.settings);
});

app.post('/api/admin/settings', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  
  db.settings = { ...db.settings, ...req.body };
  res.json({ message: 'Settings updated', settings: db.settings });
});

// Employee Check-in (Automatic Logic)
app.post('/api/checkin', authenticate, async (req, res) => {
  const time = new Date();
  const dateStr = time.toISOString().split('T')[0];
  const existingRecord = db.attendance.find(a => a.userId === req.user.id && a.date === dateStr);
  if (existingRecord) return res.status(400).json({ message: 'Already checked in today' });

  const startTime = new Date();
  const [hours, mins] = db.settings.officeStartTime.split(':');
  startTime.setHours(parseInt(hours), parseInt(mins), 0);
  
  let penalty = 0;
  let status = 'On Time Check-in';
  
  const diffMins = (time.getTime() - startTime.getTime()) / 60000;
  if (diffMins > db.settings.lateToleranceMins) {
    penalty = db.settings.latePenalty;
    status = 'Late Check-in';
  }

  const record = {
    id: db.attendance.length + 1,
    userId: req.user.id,
    date: dateStr,
    checkInTime: time.toISOString(),
    checkOutTime: null,
    status,
    totalPenaltyApplied: penalty
  };
  db.attendance.push(record);

  if (penalty > 0) await applyPenalty(req.user.id, penalty, status);
  
  // Attendance config matching: Date, EmployeeID, CheckIn, CheckOut, Status, Penalty
  await syncToGoogleSheets('Attendance', [dateStr, req.user.id, time.toISOString(), 'Pending', status, penalty]);
  res.json({ message: 'Checked in successfully', record });
});

// Employee Check-out
app.post('/api/checkout', authenticate, async (req, res) => {
  const time = new Date();
  const dateStr = time.toISOString().split('T')[0];
  const record = db.attendance.find(a => a.userId === req.user.id && a.date === dateStr);
  if (!record) return res.status(400).json({ message: 'No check-in found for today' });
  if (record.checkOutTime) return res.status(400).json({ message: 'Already checked out today' });

  record.checkOutTime = time.toISOString();
  const checkInDate = new Date(record.checkInTime);
  const workedHours = (time.getTime() - checkInDate.getTime()) / (1000 * 60 * 60);

  let penalty = 0;
  let penaltyReason = [];
  
  if (workedHours < db.settings.halfDayHours) {
    penalty = db.settings.halfDayPenalty;
    record.status = record.status + ' | Half-day (Insufficient Hours)';
    penaltyReason.push('Half-day Penalty');
  } else if (workedHours < db.settings.requiredHours) {
    penalty = db.settings.earlyCheckoutPenalty;
    record.status = record.status + ' | Early Checkout';
    penaltyReason.push('Early Checkout Penalty');
  }

  record.totalPenaltyApplied += penalty;
  if (penalty > 0) await applyPenalty(req.user.id, penalty, penaltyReason.join(', '));

  // Attendance config matching: Date, EmployeeID, CheckIn, CheckOut, Status, Penalty
  await syncToGoogleSheets('Attendance', [dateStr, req.user.id, record.checkInTime, time.toISOString(), record.status, record.totalPenaltyApplied]);
  res.json({ message: 'Checked out successfully', record });
});

// End of Day Process (cron sim - mark full-day leave for those absent)
app.post('/api/admin/end-of-day', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  
  const dateStr = new Date().toISOString().split('T')[0];
  const absentUsers = [];

  // Iterate over all active employees
  for (const user of db.users.filter(u => u.role === 'employee')) {
    const hasAttended = db.attendance.some(a => a.userId === user.id && a.date === dateStr);
    
    // Rule: No check-in -> mark full-day leave
    if (!hasAttended) {
      absentUsers.push(user.name);
      const penalty = db.settings.fullDayPenalty;
      const record = {
        id: db.attendance.length + 1,
        userId: user.id,
        date: dateStr,
        checkInTime: null,
        checkOutTime: null,
        status: 'Absent / Full-day Leave',
        totalPenaltyApplied: penalty
      };
      
      db.attendance.push(record);
      await applyPenalty(user.id, penalty, 'Absent (No Check-in)');
      await syncToGoogleSheets('Attendance', record);
    }
  }

  res.json({ message: 'End of Day Process Complete. Absences Logged.', absentUsers });
});

// Fetch Employee Details 
app.get('/api/employee/dashboard', authenticate, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  const attendance = db.attendance.filter(a => a.userId === req.user.id);
  res.json({ 
    user: { name: user.name, baseSalary: user.baseSalary, currentSalary: user.currentSalary },
    penalties: user.penalties,
    attendance
  });
});

// --- LEAVES & TASKS APIs ---
db.leaves = [];
db.tasks = [
  { id: 1, userId: 2, name: 'API Integration', type: 'Weekly', dueDate: 'Oct 20, 2026', status: 'In Progress' }
];

app.post('/api/apply-leave', authenticate, async (req, res) => {
  const { type, dates, reason } = req.body;
  const newLeave = {
    id: db.leaves.length + 1,
    userId: req.user.id,
    userName: db.users.find(u => u.id === req.user.id)?.name || 'Unknown',
    type, dates, reason, status: 'Pending',
    createdAt: new Date().toISOString()
  };
  db.leaves.push(newLeave);
  // Leaves configuration matching: LeaveID, EmployeeID, FromDate, ToDate, Reason, Status, ApprovedBy
  // using split to handle dates "2026-05-10" or similar
  await syncToGoogleSheets('Leaves', [newLeave.id, req.user.id, dates, dates, reason, 'Pending', 'Pending']);
  res.json({ message: 'Leave request submitted', leave: newLeave });
});

app.get('/api/leaves', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    res.json(db.leaves);
  } else {
    res.json(db.leaves.filter(l => l.userId === req.user.id));
  }
});

app.post('/api/approve-leave', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  const { leaveId, status } = req.body;
  const leave = db.leaves.find(l => l.id === parseInt(leaveId));
  if (!leave) return res.status(404).json({ message: 'Not found' });
  
  leave.status = status; // 'Approved' or 'Rejected'
  // Leaves: LeaveID, EmployeeID, FromDate, ToDate, Reason, Status, ApprovedBy
  await syncToGoogleSheets('Leaves', [leave.id, leave.userId, leave.dates, leave.dates, leave.reason, leave.status, req.user.id]);
  res.json({ message: `Leave ${leave.status}`, leave });
});

app.get('/api/tasks', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    res.json(db.tasks);
  } else {
    res.json(db.tasks.filter(t => t.userId === req.user.id));
  }
});

app.post('/api/tasks/:id/complete', authenticate, async (req, res) => {
  const task = db.tasks.find(t => t.id === parseInt(req.params.id) && t.userId === req.user.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  
  task.status = 'Completed';
  // Tasks mapping: TaskID, EmployeeID, Title, Description, Status, Date
  await syncToGoogleSheets('Tasks', [task.id, task.userId, task.name, task.type, task.status, new Date().toISOString().split('T')[0]]);
  res.json({ message: 'Task completed', task });
});

// Serve Frontend dynamically in Production (Combined Link)
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`PEACE ASSOCIATION HRMS Backend running on port ${PORT}`);
});
