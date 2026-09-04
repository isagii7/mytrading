const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase Admin Initialization ----------
// Load service account from environment variables (Vercel) or local file
let serviceAccount;
if (process.env.FIREBASE_PROJECT_ID) {
  serviceAccount = {
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || 'googleapis.com'
  };
} else {
  // Local development – load from file (make sure file exists)
  try {
    serviceAccount = require('./service-account.json');
  } catch (e) {
    console.error('❌ Service account file not found. Set environment variables.');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersCollection = db.collection('users');
const transactionsCollection = db.collection('transactions');
const investmentsCollection = db.collection('investments');

// ---------- Plan Definitions ----------
const PLANS = [
  { id: 'p1', tag: 'GROWTH PLAN 01', name: 'NEXTY-01', amount: 450, dailyProfit: 112, days: 75, totalProfit: 8400 },
  { id: 'p2', tag: 'GROWTH PLAN 02', name: 'NEXTY-02', amount: 1235, dailyProfit: 308, days: 75, totalProfit: 23100 },
  { id: 'p3', tag: 'GROWTH PLAN 03', name: 'NEXTY-03', amount: 2875, dailyProfit: 719, days: 75, totalProfit: 53925 },
  { id: 'p4', tag: 'GROWTH PLAN 04', name: 'NEXTY-04', amount: 6355, dailyProfit: 1588, days: 75, totalProfit: 119100 },
  { id: 'p5', tag: 'GROWTH PLAN 05', name: 'NEXTY-05', amount: 12755, dailyProfit: 3188, days: 75, totalProfit: 239100 },
  { id: 'p6', tag: 'GROWTH PLAN 06', name: 'NEXTY-06', amount: 27750, dailyProfit: 6937, days: 75, totalProfit: 520275 },
  { id: 'p7', tag: 'GROWTH PLAN 07', name: 'NEXTY-07', amount: 57750, dailyProfit: 14437, days: 75, totalProfit: 1082775 }
];
const REFER_L1 = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Helper: get user with transactions & investments ----------
async function getUser(username) {
  const doc = await usersCollection.doc(username).get();
  if (!doc.exists) return null;
  const userData = { username: doc.id, ...doc.data() };
  // Fetch transactions
  const txSnap = await transactionsCollection.where('username', '==', username).get();
  userData.transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Fetch investments
  const invSnap = await investmentsCollection.where('username', '==', username).get();
  userData.investments = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return userData;
}

// ---------- Ensure admin exists ----------
async function ensureAdmin() {
  const adminUser = await getUser('nexty');
  if (!adminUser) {
    await usersCollection.doc('nexty').set({
      password: 'INTROVERT.12',
      referrer: 'SYSTEM',
      balance: 0,
      pendingDeposit: 0,
      pendingWithdraw: 0,
      totalInvestment: 0,
      totalWithdraw: 0,
      totalProfit: 0,
      referBonus: 0,
      teamMembers: 0,
      teamInvestment: 0,
      referrals: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Admin user created');
  }
}
ensureAdmin();

// ---------- Routes ----------

// Register
app.post('/api/register', async (req, res) => {
  const { username, password, referrer } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const existing = await getUser(username);
  if (existing) return res.status(400).json({ error: 'Username already exists' });

  await usersCollection.doc(username).set({
    password,
    referrer: referrer || 'ALY',
    balance: 0,
    pendingDeposit: 0,
    pendingWithdraw: 0,
    totalInvestment: 0,
    totalWithdraw: 0,
    totalProfit: 0,
    referBonus: 0,
    teamMembers: 0,
    teamInvestment: 0,
    referrals: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Referral bonus to referrer
  if (referrer) {
    const refDoc = await usersCollection.doc(referrer).get();
    if (refDoc.exists && referrer !== username) {
      await usersCollection.doc(referrer).update({
        teamMembers: admin.firestore.FieldValue.increment(1),
        referrals: admin.firestore.FieldValue.arrayUnion(username),
        balance: admin.firestore.FieldValue.increment(50),
        referBonus: admin.firestore.FieldValue.increment(50)
      });
    }
  }
  res.json({ success: true, username });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await getUser(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.password !== password) return res.status(401).json({ error: 'Invalid password' });
  delete user.password;
  res.json({ success: true, user });
});

// Get user (refresh)
app.get('/api/user/:username', async (req, res) => {
  const user = await getUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.password;
  res.json(user);
});

// Deposit
app.post('/api/deposit', async (req, res) => {
  const { username, amount, txid } = req.body;
  const user = await getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const txRef = transactionsCollection.doc();
  await txRef.set({
    id: txRef.id,
    username,
    type: 'deposit',
    amount,
    status: 'pending',
    method: 'EasyPaisa (' + (txid || 'no TXID') + ')',
    date: new Date().toLocaleString(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await usersCollection.doc(username).update({
    pendingDeposit: admin.firestore.FieldValue.increment(amount)
  });
  res.json({ success: true, tx: { id: txRef.id } });
});

// Withdraw
app.post('/api/withdraw', async (req, res) => {
  const { username, amount, account } = req.body;
  const user = await getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (amount > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const txRef = transactionsCollection.doc();
  await txRef.set({
    id: txRef.id,
    username,
    type: 'withdraw',
    amount,
    status: 'pending',
    method: 'EasyPaisa ' + (account || ''),
    date: new Date().toLocaleString(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await usersCollection.doc(username).update({
    balance: admin.firestore.FieldValue.increment(-amount),
    pendingWithdraw: admin.firestore.FieldValue.increment(amount)
  });
  res.json({ success: true, tx: { id: txRef.id } });
});

// Invest
app.post('/api/invest', async (req, res) => {
  const { username, planId } = req.body;
  const user = await getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const plan = PLANS.find(p => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  if (plan.amount > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const invRef = investmentsCollection.doc();
  await invRef.set({
    id: invRef.id,
    username,
    plan: plan.id,
    amount: plan.amount,
    days: plan.days,
    startTime: Date.now(),
    daysCredited: 0,
    accrued: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await usersCollection.doc(username).update({
    balance: admin.firestore.FieldValue.increment(-plan.amount),
    totalInvestment: admin.firestore.FieldValue.increment(plan.amount)
  });
  res.json({ success: true });
});

// Admin: get pending
app.get('/api/admin/pending/:type', async (req, res) => {
  const type = req.params.type;
  const snap = await transactionsCollection.where('type', '==', type).where('status', '==', 'pending').get();
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json(pending);
});

// Admin: approve
app.post('/api/admin/approve', async (req, res) => {
  const { txId } = req.body;
  const txDoc = await transactionsCollection.doc(txId).get();
  if (!txDoc.exists) return res.status(404).json({ error: 'Transaction not found' });
  const tx = txDoc.data();
  if (tx.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  await transactionsCollection.doc(txId).update({ status: 'approved' });

  if (tx.type === 'deposit') {
    await usersCollection.doc(tx.username).update({
      pendingDeposit: admin.firestore.FieldValue.increment(-tx.amount),
      balance: admin.firestore.FieldValue.increment(tx.amount),
      totalInvestment: admin.firestore.FieldValue.increment(tx.amount)
    });
    // Referral bonus
    const userDoc = await usersCollection.doc(tx.username).get();
    const userData = userDoc.data();
    if (userData.referrer && userData.referrer !== tx.username) {
      const refDoc = await usersCollection.doc(userData.referrer).get();
      if (refDoc.exists) {
        const bonus = tx.amount * (REFER_L1 / 100);
        await usersCollection.doc(userData.referrer).update({
          referBonus: admin.firestore.FieldValue.increment(bonus),
          balance: admin.firestore.FieldValue.increment(bonus)
        });
      }
    }
  } else {
    await usersCollection.doc(tx.username).update({
      pendingWithdraw: admin.firestore.FieldValue.increment(-tx.amount),
      totalWithdraw: admin.firestore.FieldValue.increment(tx.amount)
    });
  }
  res.json({ success: true });
});

// Admin: reject
app.post('/api/admin/reject', async (req, res) => {
  const { txId } = req.body;
  const txDoc = await transactionsCollection.doc(txId).get();
  if (!txDoc.exists) return res.status(404).json({ error: 'Transaction not found' });
  const tx = txDoc.data();
  if (tx.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  await transactionsCollection.doc(txId).update({ status: 'rejected' });

  if (tx.type === 'deposit') {
    await usersCollection.doc(tx.username).update({
      pendingDeposit: admin.firestore.FieldValue.increment(-tx.amount)
    });
  } else {
    await usersCollection.doc(tx.username).update({
      pendingWithdraw: admin.firestore.FieldValue.increment(-tx.amount),
      balance: admin.firestore.FieldValue.increment(tx.amount) // refund
    });
  }
  res.json({ success: true });
});

// ---------- Profit Accrual (runs every 10 sec) ----------
async function accrueProfits() {
  const usersSnap = await usersCollection.get();
  for (const userDoc of usersSnap.docs) {
    const username = userDoc.id;
    const invSnap = await investmentsCollection.where('username', '==', username).get();
    let updated = false;
    for (const invDoc of invSnap.docs) {
      const inv = invDoc.data();
      const plan = PLANS.find(p => p.id === inv.plan);
      if (!plan) continue;
      const elapsed = Date.now() - inv.startTime;
      const fullDays = Math.min(inv.days, Math.floor(elapsed / DAY_MS));
      if (fullDays > (inv.daysCredited || 0)) {
        const daysToPay = fullDays - (inv.daysCredited || 0);
        const delta = plan.dailyProfit * daysToPay;
        await investmentsCollection.doc(invDoc.id).update({
          daysCredited: fullDays,
          accrued: admin.firestore.FieldValue.increment(delta)
        });
        await usersCollection.doc(username).update({
          totalProfit: admin.firestore.FieldValue.increment(delta),
          balance: admin.firestore.FieldValue.increment(delta)
        });
        updated = true;
      }
    }
  }
}
setInterval(accrueProfits, 10000);

// ---------- Export for Vercel ----------
module.exports = serverless(app);
