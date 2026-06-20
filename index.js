require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const exceljs = require('exceljs');
const nodemailer = require('nodemailer'); // <-- MUST BE HERE
const cron = require('node-cron');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const otpStore = new Map();

// ==========================================
// EMAIL CONFIGURATION (STRICT IPv4)
// ==========================================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4, // <-- THIS IS THE MAGIC FIX. It forces the socket to strictly use IPv4.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});


// ==========================================
// MIDDLEWARE: The SaaS "Bouncer" 
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; 
  if (!token) return res.status(401).json({ error: "Access Denied" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid Token" });
    req.user = user; 
    next(); 
  });
};

// ==========================================
// ROUTE 1 & 2: Auth (Login & OTP)
// ==========================================
app.post('/api/auth/request-otp', async (req, res) => {
  console.log("\n=== 🚦 NEW OTP REQUEST ===");
  console.log("Body received from app:", req.body);

  const { email } = req.body;
  if (!email) {
    console.log("❌ ERROR: No email found in the request body!");
    return res.status(400).json({ error: "Email is required" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email, otp);
  setTimeout(() => otpStore.delete(email), 5 * 60 * 1000);

  console.log(`⏳ Attempting to send OTP ${otp} via Google Mail Servers...`);

  try {
    await transporter.sendMail({
      from: `"Easy Wheels Command" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your Easy Wheels Login Code",
      text: `Welcome back to Fleet Command. Your secure login OTP is: ${otp}\n\nThis code expires in 5 minutes.`
    });
    
    console.log(`✅ SUCCESS: Email sent to ${email}`);
    res.json({ message: "OTP sent to your email!" });
  } catch (error) {
    console.error("❌ CRITICAL EMAIL ERROR:", error);
    res.status(500).json({ error: "Failed to send OTP email" });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  console.log("\n=== 🔐 OTP VERIFICATION ATTEMPT ===");
  console.log("Body received from app:", req.body);

  // Clean the inputs (destroy hidden spaces)
  const email = req.body.email ? req.body.email.trim().toLowerCase() : "";
  const otp = req.body.otp ? req.body.otp.trim() : "";
  
  const storedOtp = otpStore.get(email);
  
  console.log(`Email searching for:  [${email}]`);
  console.log(`Stored OTP in memory: [${storedOtp}]`);
  console.log(`OTP entered by user:  [${otp}]`);

  if (!storedOtp || storedOtp !== otp) {
    console.log("❌ ERROR: OTPs do not match, or RAM was wiped!");
    return res.status(401).json({ error: "Invalid or expired OTP" });
  }

  console.log("✅ SUCCESS: OTP Matched! Generating secure token...");
  otpStore.delete(email);

  try {
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const role = email === process.env.EMAIL_USER ? "ADMIN" : "USER"; 
      user = await prisma.user.create({
        data: { email, name: "Fleet Owner", role }
      });
    }

    if (!user.isActive) return res.status(403).json({ error: "Account Disabled by Admin" });

    await prisma.auditLog.create({
      data: { action: "USER_LOGIN", details: `${user.role} logged in.`, userId: user.id }
    });

    const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ message: "Login successful", token, user });
  } catch (error) {
    console.error("Database Error during login:", error);
    res.status(500).json({ error: "Internal Server Error during login" });
  }
});

// ==========================================
// ROUTE 3: Log a Trip (Multi-Tenant)
// ==========================================
app.post('/api/trips', authenticateToken, async (req, res) => {
  const { vehiclePlate, billAmount, notes, source, destination, driverFare, tripDate, driverPhone, driverName } = req.body;
  
  try {
    if (!driverPhone) return res.status(400).json({ error: "Driver phone required." });

    // 1. Find/Create Driver strictly tied to this Fleet Owner
    let driver = await prisma.driver.findFirst({ 
      where: { phoneNumber: driverPhone, userId: req.user.id } 
    });
    
    if (!driver) {
      driver = await prisma.driver.create({
        data: { name: driverName || "Unknown Driver", phoneNumber: driverPhone, userId: req.user.id }
      });
    }

    // 2. Find/Create Vehicle (Plates are global, so check ownership)
    let vehicle = await prisma.vehicle.findUnique({ where: { plateNo: vehiclePlate } });
    if (!vehicle) {
      vehicle = await prisma.vehicle.create({
        data: { plateNo: vehiclePlate, userId: req.user.id, driverId: driver.id }
      });
    } else if (vehicle.userId !== req.user.id) {
      return res.status(403).json({ error: "This vehicle is registered to another Fleet Company." });
    }

    // 3. Create the Trip strictly under this Fleet Owner
    const trip = await prisma.trip.create({
      data: {
        userId: req.user.id,
        driverId: driver.id,
        vehicleId: vehicle.id,
        income: parseFloat(billAmount),
        source: source || "Not Specified",
        destination: destination || "Not Specified",
        driverFare: driverFare ? parseFloat(driverFare) : 0.0,
        tripDate: tripDate ? new Date(tripDate) : new Date(),
        notes: notes || ""
      }
    });

    await prisma.auditLog.create({
      data: { action: "TRIP_CREATED", details: `Logged trip for ${vehiclePlate}`, userId: req.user.id }
    });

    res.json({ message: "Trip logged successfully!", trip });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save trip log" });
  }
});

// ==========================================
// ROUTE 4: Fetch Owner's Trips
// ==========================================
app.get('/api/trips', authenticateToken, async (req, res) => {
  try {
    // Only return trips owned by the logged-in User
    const trips = await prisma.trip.findMany({
      where: { userId: req.user.id },
      include: { vehicle: true, driver: true },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    res.json(trips);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch trips" });
  }
});

// ==========================================
// ROUTE 5: Log a Business Expense
// ==========================================
app.post('/api/expenses', authenticateToken, async (req, res) => {
  const { amount, category, notes, vehiclePlate } = req.body;
  
  try {
    let vehicleId = null;
    if (vehiclePlate) {
      const vehicle = await prisma.vehicle.findUnique({ where: { plateNo: vehiclePlate } });
      if (vehicle && vehicle.userId === req.user.id) vehicleId = vehicle.id;
    }

    const expense = await prisma.expense.create({
      data: {
        userId: req.user.id,
        amount: parseFloat(amount),
        category: category,
        notes: notes || "",
        vehicleId: vehicleId
      }
    });

    res.json({ message: "Expense logged successfully!", expense });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to log expense" });
  }
});

// ==========================================
// ROUTE 6: Fleet Owner Dashboard Analytics
// ==========================================
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    // Only calculate money owned by THIS specific Fleet Owner
    const trips = await prisma.trip.findMany({ where: { userId: req.user.id } });
    const totalRevenue = trips.reduce((sum, trip) => sum + trip.income, 0);

    const expenses = await prisma.expense.findMany({ where: { userId: req.user.id } });
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    const profit = totalRevenue - totalExpenses;

    res.json({ totalRevenue, totalExpenses, profit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ==========================================
// ROUTE 7: Fleet Registry (Owner's View)
// ==========================================
app.get('/api/fleet', authenticateToken, async (req, res) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { userId: req.user.id },
      include: { driver: true, trips: true, expenses: true }
    });

    const fleetStats = vehicles.map(v => {
      const revenue = v.trips.reduce((sum, t) => sum + t.income, 0);
      const expense = v.expenses.reduce((sum, e) => sum + e.amount, 0);
      return {
        id: v.id,
        plateNo: v.plateNo,
        driverName: v.driver ? v.driver.name : "Unassigned",
        revenue,
        expense,
        profit: revenue - expense
      };
    });

    res.json(fleetStats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch fleet data" });
  }
});

// ==========================================
// ROUTE 8: Team Roster (Owner's View)
// ==========================================
app.get('/api/team', authenticateToken, async (req, res) => {
  try {
    const drivers = await prisma.driver.findMany({
      where: { userId: req.user.id },
      include: { trips: true, vehicles: true }
    });

    const teamStats = drivers.map(d => {
      const revenue = d.trips.reduce((sum, t) => sum + t.income, 0);
      return {
        id: d.id,
        name: d.name,
        phone: d.phoneNumber,
        totalTrips: d.trips.length,
        revenueGenerated: revenue,
        assignedVehicles: d.vehicles.map(v => v.plateNo).join(', ') || 'Unassigned'
      };
    });

    res.json(teamStats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch team roster" });
  }
});

// ==========================================
// ROUTE 9: Explicit Vehicle Registry
// ==========================================
app.post('/api/vehicles', authenticateToken, async (req, res) => {
  const { plateNo, vehicleType, insuranceExpiry, permitExpiry, notes } = req.body;
  
  try {
    // 1. Clean the plate number
    const dbReadyPlate = plateNo.replace(/[\s-]/g, '').toUpperCase();

    // 2. Check if it belongs to someone else
    let vehicle = await prisma.vehicle.findUnique({ where: { plateNo: dbReadyPlate } });
    if (vehicle && vehicle.userId !== req.user.id) {
      return res.status(403).json({ error: "Vehicle registered to another Fleet Company." });
    }
    
    // 3. SAFE DATE PARSER: Destroys hidden spaces and validates format
    const parseDate = (dateStr) => {
      if (!dateStr || dateStr.trim() === "") return null; // Ignore blanks and spaces
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) return undefined; // Flag true invalid formats
      return parsed;
    };

    const parsedIns = parseDate(insuranceExpiry);
    const parsedPerm = parseDate(permitExpiry);

    // If they typed letters instead of a date, warn them nicely
    if (parsedIns === undefined || parsedPerm === undefined) {
      return res.status(400).json({ error: "Invalid date format. Please use YYYY-MM-DD." });
    }

    // 4. Prepare the detailed data payload
    const data = {
      userId: req.user.id,
      plateNo: dbReadyPlate,
      vehicleType: vehicleType || "Truck",
      insuranceExpiry: parsedIns,
      permitExpiry: parsedPerm,
      notes: notes || ""
    };

    // 5. Update if it exists, Create if it doesn't
    if (vehicle) {
      vehicle = await prisma.vehicle.update({ where: { plateNo: dbReadyPlate }, data });
    } else {
      vehicle = await prisma.vehicle.create({ data });
    }

    // Log the action
    await prisma.auditLog.create({
      data: { action: "VEHICLE_UPDATED", details: `Updated registry for ${dbReadyPlate}`, userId: req.user.id }
    });

    res.json({ message: "Vehicle registry updated successfully!", vehicle });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update vehicle registry" });
  }
});

// ==========================================
// ROUTE 10: Notification Engine (Expiries)
// ==========================================
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const today = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(today.getDate() + 30);

    // Fetch the owner's entire fleet
    const vehicles = await prisma.vehicle.findMany({ where: { userId: req.user.id } });
    const alerts = [];

    // Check every truck for upcoming expirations
    vehicles.forEach(v => {
      if (v.insuranceExpiry && v.insuranceExpiry <= thirtyDaysFromNow) {
        const isExpired = v.insuranceExpiry < today;
        alerts.push({
          type: "INSURANCE",
          plate: v.plateNo,
          message: isExpired ? `🚨 OVERDUE: Insurance for ${v.plateNo} expired!` : `⚠️ WARNING: Insurance for ${v.plateNo} expires soon.`,
          date: v.insuranceExpiry.toLocaleDateString()
        });
      }
      if (v.permitExpiry && v.permitExpiry <= thirtyDaysFromNow) {
        const isExpired = v.permitExpiry < today;
        alerts.push({
          type: "PERMIT",
          plate: v.plateNo,
          message: isExpired ? `🚨 OVERDUE: Permit for ${v.plateNo} expired!` : `⚠️ WARNING: Permit for ${v.plateNo} expires soon.`,
          date: v.permitExpiry.toLocaleDateString()
        });
      }
    });

    res.json(alerts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate notifications" });
  }
});

// ==========================================
// ROUTE 11: Explicit Driver Registry
// ==========================================
app.post('/api/drivers', authenticateToken, async (req, res) => {
  const { driverPhone, licenseExpiry } = req.body;
  
  try {
    if (!driverPhone) return res.status(400).json({ error: "Driver Phone required." });

    // Find the exact driver owned by this Fleet Company
    let driver = await prisma.driver.findFirst({ 
      where: { phoneNumber: driverPhone, userId: req.user.id } 
    });

    if (!driver) {
      return res.status(404).json({ error: "Driver not found in your Team." });
    }

    // Safe Date Parser
    const parseDate = (dateStr) => {
      if (!dateStr || dateStr.trim() === "") return null;
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) return undefined;
      return parsed;
    };

    const parsedExpiry = parseDate(licenseExpiry);
    if (parsedExpiry === undefined) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    // Update the Driver
    driver = await prisma.driver.update({
      where: { id: driver.id },
      data: { licenseExpiry: parsedExpiry }
    });

    // Log the action
    await prisma.auditLog.create({
      data: { action: "DRIVER_UPDATED", details: `Updated documents for driver ${driverPhone}`, userId: req.user.id }
    });

    res.json({ message: "Driver documents updated successfully!", driver });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update driver registry" });
  }
});

// ==========================================
// ROUTE 12: Fleet Owner Monthly Excel Report
// ==========================================
app.get('/api/reports/monthly', authenticateToken, async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0,0,0,0);

    // 1. Fetch Trips for this month
    const trips = await prisma.trip.findMany({
      where: { userId: req.user.id, tripDate: { gte: startOfMonth } },
      include: { vehicle: true, driver: true }
    });

    // 2. Fetch Expenses for this month
    const expenses = await prisma.expense.findMany({
      where: { userId: req.user.id, createdAt: { gte: startOfMonth } },
      include: { vehicle: true }
    });

    // Calculate Totals
    const totalRevenue = trips.reduce((sum, trip) => sum + trip.income, 0);
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
    const netProfit = totalRevenue - totalExpenses;

    const workbook = new exceljs.Workbook();

    // --- SHEET 1: REVENUE ---
    const tripSheet = workbook.addWorksheet('Trips & Revenue');
    tripSheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Driver', key: 'driver', width: 20 },
      { header: 'Vehicle Plate', key: 'plate', width: 15 },
      { header: 'Route', key: 'route', width: 25 },
      { header: 'Income (₹)', key: 'income', width: 15 },
      { header: 'Notes', key: 'notes', width: 30 } // NEW: Added Notes column
    ];
    trips.forEach(t => tripSheet.addRow({
      date: t.tripDate.toLocaleDateString(),
      driver: t.driver.name || t.driver.phoneNumber,
      plate: t.vehicle.plateNo,
      route: `${t.source} ➔ ${t.destination}`,
      income: t.income,
      notes: t.notes || "" // Ensure it maps to the notes field
    }));
    tripSheet.addRow({ date: 'TOTAL REVENUE', driver: '', plate: '', route: '', income: totalRevenue, notes: '' });

    // --- SHEET 2: EXPENSES ---
    const expSheet = workbook.addWorksheet('Expenses');
    expSheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Vehicle Plate', key: 'plate', width: 15 },
      { header: 'Amount (₹)', key: 'amount', width: 15 }
    ];
    expenses.forEach(e => expSheet.addRow({
      date: e.createdAt.toLocaleDateString(),
      category: e.category,
      plate: e.vehicle ? e.vehicle.plateNo : 'N/A',
      amount: e.amount
    }));
    expSheet.addRow({ date: 'TOTAL EXPENSES', category: '', plate: '', amount: totalExpenses });

    // --- SHEET 3: PROFIT SUMMARY ---
    const summarySheet = workbook.addWorksheet('Financial Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Amount (₹)', key: 'amount', width: 20 }
    ];
    summarySheet.addRow({ metric: 'Total Revenue', amount: totalRevenue });
    summarySheet.addRow({ metric: 'Total Expenses', amount: totalExpenses });
    summarySheet.addRow({ metric: 'Net Profit', amount: netProfit });

    await prisma.auditLog.create({
      data: { action: "REPORT_DOWNLOADED", details: "Downloaded comprehensive financial report.", userId: req.user.id }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Fleet_Financial_Report.xlsx');
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate Excel report" });
  }
});

// ==========================================
// ROUTE 13: Super Admin - Platform Stats
// ==========================================
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    const totalUsers = await prisma.user.count({ where: { role: 'USER' } });
    const totalVehicles = await prisma.vehicle.count();
    const totalTrips = await prisma.trip.count();
    
    // Calculate money moving through the ENTIRE platform
    const trips = await prisma.trip.findMany();
    const totalPlatformRevenue = trips.reduce((sum, trip) => sum + trip.income, 0);

    res.json({ totalUsers, totalVehicles, totalTrips, totalPlatformRevenue });
  } catch (error) {
    res.status(500).json({ error: "Failed to load platform stats" });
  }
});

// ==========================================
// ROUTE 14: Super Admin - Client List
// ==========================================
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    const users = await prisma.user.findMany({
      where: { role: 'USER' },
      include: { vehicles: true, drivers: true, trips: true },
      orderBy: { createdAt: 'desc' }
    });

    // Format the data so the dashboard is clean
    const clientList = users.map(user => {
      const revenue = user.trips.reduce((sum, t) => sum + t.income, 0);
      return {
        id: user.id,
        email: user.email,
        status: user.isActive ? "Active" : "Banned",
        fleetSize: user.vehicles.length,
        teamSize: user.drivers.length,
        totalRevenueGenerated: revenue,
        joined: user.createdAt.toLocaleDateString()
      };
    });

    res.json(clientList);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch clients" });
  }
});

// ==========================================
// ROUTE 15: Super Admin - Global Audit Logs
// ==========================================
app.get('/api/admin/logs', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    // See the last 50 actions taken by anyone on the platform
    const logs = await prisma.auditLog.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// ==========================================
// ROUTE 16: Super Admin - Create User Manually
// ==========================================
app.post('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });
  const { email, role } = req.body;

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: "User already exists" });

    const newUser = await prisma.user.create({
      data: { email, role: role || 'USER', name: "Fleet Owner" }
    });

    await prisma.auditLog.create({
      data: { action: "ADMIN_ACTION", details: `Created new user: ${email}`, userId: req.user.id }
    });

    res.json({ message: "User created successfully", user: newUser });
  } catch (error) {
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ==========================================
// ROUTE 17: Super Admin - Toggle User Status (Disable/Enable)
// ==========================================
app.put('/api/admin/users/:id/status', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });
  
  try {
    const { isActive } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive }
    });

    await prisma.auditLog.create({
      data: { action: "ADMIN_ACTION", details: `${isActive ? 'Enabled' : 'Disabled'} account: ${user.email}`, userId: req.user.id }
    });

    res.json({ message: `User ${isActive ? 'enabled' : 'disabled'}`, user });
  } catch (error) {
    res.status(500).json({ error: "Failed to update user status" });
  }
});

// ==========================================
// ROUTE 18: Super Admin - Delete User
// ==========================================
app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    const user = await prisma.user.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: { action: "ADMIN_ACTION", details: `Permanently deleted user: ${user.email}`, userId: req.user.id }
    });

    res.json({ message: "User permanently deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ==========================================
// ROUTE 19: Super Admin - Database Backup (Export)
// ==========================================
app.get('/api/admin/backup', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    // Gather literally everything in the database
    const fullDatabase = {
      users: await prisma.user.findMany(),
      vehicles: await prisma.vehicle.findMany(),
      drivers: await prisma.driver.findMany(),
      trips: await prisma.trip.findMany(),
      expenses: await prisma.expense.findMany(),
      auditLogs: await prisma.auditLog.findMany()
    };

    await prisma.auditLog.create({
      data: { action: "SYSTEM_BACKUP", details: "Super Admin downloaded a full system backup.", userId: req.user.id }
    });

    // Send it back as a downloadable JSON file
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=EasyWheels_System_Backup.json');
    res.send(JSON.stringify(fullDatabase, null, 2));
  } catch (error) {
    res.status(500).json({ error: "Failed to generate backup" });
  }
});

// ==========================================
// ROUTE 20: Super Admin - View Any User's Report
// ==========================================
app.get('/api/admin/reports/:userId', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Unauthorized" });

  try {
    const { userId } = req.params;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0,0,0,0);

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) return res.status(404).json({ error: "Client not found" });

    // 1. Fetch Trips for this specific client
    const trips = await prisma.trip.findMany({
      where: { userId: userId, tripDate: { gte: startOfMonth } },
      include: { vehicle: true, driver: true }
    });

    // 2. Fetch Expenses for this specific client
    const expenses = await prisma.expense.findMany({
      where: { userId: userId, createdAt: { gte: startOfMonth } },
      include: { vehicle: true }
    });

    // Calculate Totals
    const totalRevenue = trips.reduce((sum, trip) => sum + trip.income, 0);
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
    const netProfit = totalRevenue - totalExpenses;

    const workbook = new exceljs.Workbook();

    // --- SHEET 1: REVENUE ---
    const tripSheet = workbook.addWorksheet('Trips & Revenue');
    tripSheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Driver', key: 'driver', width: 20 },
      { header: 'Vehicle Plate', key: 'plate', width: 15 },
      { header: 'Route', key: 'route', width: 25 },
      { header: 'Income (₹)', key: 'income', width: 15 },
      { header: 'Notes', key: 'notes', width: 30 }
    ];
    trips.forEach(t => tripSheet.addRow({
      date: t.tripDate.toLocaleDateString(),
      driver: t.driver.name || t.driver.phoneNumber,
      plate: t.vehicle.plateNo,
      route: `${t.source} ➔ ${t.destination}`,
      income: t.income,
      notes: t.notes || ""
    }));
    tripSheet.addRow({ date: 'TOTAL REVENUE', driver: '', plate: '', route: '', income: totalRevenue, notes: '' });

    // --- SHEET 2: EXPENSES ---
    const expSheet = workbook.addWorksheet('Expenses');
    expSheet.columns = [
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Vehicle Plate', key: 'plate', width: 15 },
      { header: 'Amount (₹)', key: 'amount', width: 15 }
    ];
    expenses.forEach(e => expSheet.addRow({
      date: e.createdAt.toLocaleDateString(),
      category: e.category,
      plate: e.vehicle ? e.vehicle.plateNo : 'N/A',
      amount: e.amount
    }));
    expSheet.addRow({ date: 'TOTAL EXPENSES', category: '', plate: '', amount: totalExpenses });

    // --- SHEET 3: PROFIT SUMMARY ---
    const summarySheet = workbook.addWorksheet('Financial Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Amount (₹)', key: 'amount', width: 20 }
    ];
    summarySheet.addRow({ metric: 'Total Revenue', amount: totalRevenue });
    summarySheet.addRow({ metric: 'Total Expenses', amount: totalExpenses });
    summarySheet.addRow({ metric: 'Net Profit', amount: netProfit });

    await prisma.auditLog.create({
      data: { action: "ADMIN_ACTION", details: `Super Admin downloaded report for client: ${targetUser.email}`, userId: req.user.id }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Admin_Report_${userId}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("EXCEL GENERATION ERROR:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// ==========================================
// CRON JOB: Automated Monthly Excel Delivery
// ==========================================
// Test Mode: '* * * * *' (Runs every 1 minute)
// Production Mode: '0 8 1 * *' (Runs at 8:00 AM on the 1st of every month)

// Runs at 8:00 AM on the 1st day of every month
cron.schedule('0 8 1 * *', async () => {
  console.log("\n🕒 CRON TRIGGERED: Generating Fleet Reports...");
  
  try {
    // 1. Find every active Fleet Owner in the database
    const owners = await prisma.user.findMany({ 
      where: { role: 'USER', isActive: true } 
    });

    if (owners.length === 0) return console.log("No active fleet owners found.");

    // 2. Define the exact timeframe (Current Month for testing)
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0,0,0,0);

    for (const owner of owners) {
      console.log(`📊 Processing data for: ${owner.email}`);

      // 3. Fetch their specific data
      const trips = await prisma.trip.findMany({
        where: { userId: owner.id, tripDate: { gte: startOfMonth } },
        include: { vehicle: true, driver: true }
      });
      const expenses = await prisma.expense.findMany({
        where: { userId: owner.id, createdAt: { gte: startOfMonth } },
        include: { vehicle: true }
      });

      // 4. Calculate Totals
      const totalRevenue = trips.reduce((sum, trip) => sum + trip.income, 0);
      const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      const netProfit = totalRevenue - totalExpenses;

      // 5. Build the Excel Workbook in memory (No saving to hard drive!)
      const workbook = new exceljs.Workbook();
      
      const summarySheet = workbook.addWorksheet('Financial Summary');
      summarySheet.columns = [{ header: 'Metric', key: 'metric', width: 25 }, { header: 'Amount (₹)', key: 'amount', width: 20 }];
      summarySheet.addRow({ metric: 'Total Revenue', amount: totalRevenue });
      summarySheet.addRow({ metric: 'Total Expenses', amount: totalExpenses });
      summarySheet.addRow({ metric: 'Net Profit', amount: netProfit });

      const tripSheet = workbook.addWorksheet('Trips');
      tripSheet.columns = [{ header: 'Date', key: 'date', width: 15 }, { header: 'Plate', key: 'plate', width: 15 }, { header: 'Income (₹)', key: 'income', width: 15 }];
      trips.forEach(t => tripSheet.addRow({ date: t.tripDate.toLocaleDateString(), plate: t.vehicle.plateNo, income: t.income }));

      // Convert workbook to an email-ready buffer
      const excelBuffer = await workbook.xlsx.writeBuffer();

      // 6. Fire the Email
      await transporter.sendMail({
        from: `"Easy Wheels Reports" <${process.env.EMAIL_USER}>`,
        to: owner.email,
        subject: `Your Automated Fleet Report`,
        text: `Hello from Easy Wheels,\n\nYour latest fleet report has been generated.\n\nTotal Revenue: ₹${totalRevenue}\nTotal Expenses: ₹${totalExpenses}\nNet Profit: ₹${netProfit}\n\nPlease find your detailed Excel breakdown attached.\n\nDrive safe!`,
        attachments: [
          {
            filename: `Fleet_Report.xlsx`,
            content: excelBuffer,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ]
      });

      console.log(`✅ SUCCESS: Report emailed to ${owner.email}`);
    }
  } catch (error) {
    console.error("❌ CRITICAL CRON ERROR:", error);
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SaaS API running on http://localhost:${PORT}`);
});