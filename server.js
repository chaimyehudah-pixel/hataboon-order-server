const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));
app.use("/images", express.static(path.join(__dirname, "public/images")));

const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
function readConfig(name) {
  if (process.env[name]) return String(process.env[name]).trim();
  try {
    return fs.readFileSync(path.join(__dirname, `${name}.txt`), "utf8").trim();
  } catch {
    return "";
  }
}

const APPS_SCRIPT_URL = readConfig("APPS_SCRIPT_URL");
const ZC_KEY = readConfig("ZC_KEY");
const ZC_TERMINAL = readConfig("ZC_TERMINAL");
const ZC_PASSWORD = readConfig("ZC_PASSWORD");

// 🔥 חשוב לפרודקשן
const BASE_URL =
  process.env.BASE_URL ||
  `https://${process.env.RAILWAY_STATIC_URL || "localhost:" + PORT}`;

// ===== UTILS =====
function cleanDigits(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizePhoneLocal(phoneRaw) {
  let d = cleanDigits(phoneRaw);
  if (!d) return "";
  if (d.startsWith("00972")) d = d.slice(2);
  if (d.startsWith("972") && d.length >= 12) return "0" + d.slice(3, 12);
  if (d.startsWith("0")) return d.slice(0, 10);
  return d.slice(0, 10);
}

function parseAmount(v) {
  const n = Number(String(v || "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}

// ===== APPS SCRIPT =====
async function callAppsScript(action, payload = {}) {
  if (!APPS_SCRIPT_URL) throw new Error("Missing APPS_SCRIPT_URL");

  const r = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...payload })
  });

  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Apps Script did not return JSON: " + text);
  }

  if (!data.ok) throw new Error(data.error || "Apps Script error");
  return data;
}

// ===== ZCREDIT =====
async function createZCreditSession({ orderNo, amount, name, phone }) {
  if (!ZC_KEY || !ZC_TERMINAL || !ZC_PASSWORD) {
    throw new Error("Missing payment server configuration");
  }

  const amountNumber = parseAmount(amount);
  if (!amountNumber) throw new Error("Invalid amount");

  const token = "order-" + orderNo + "-" + Date.now() + "-" + crypto.randomBytes(8).toString("hex");

  await callAppsScript("savePaymentSession", {
    token,
    orderId: orderNo,
    name,
    phone,
    amount: amountNumber,
    source: "new_order_system"
  });

  const payload = {
    Key: ZC_KEY,
    TerminalNumber: ZC_TERMINAL,
    Password: ZC_PASSWORD,
    UniqueID: token,
    Currency: "ILS",
    Total: amountNumber,
    AdditionalText: String(orderNo),
    ShowCart: false,
    SuccessUrl: BASE_URL + "/payment-success?orderId=" + encodeURIComponent(orderNo),
    CancelUrl: BASE_URL + "/payment-cancel?orderId=" + encodeURIComponent(orderNo),
    CallbackUrl: BASE_URL + "/zc-callback",
    Customer: {
      Name: name,
      PhoneNumber: phone
    },
    CartItems: [
      {
        Description: "תשלום להזמנה " + orderNo,
        Quantity: 1,
        UnitPrice: amountNumber,
        Amount: amountNumber,
        Currency: "ILS"
      }
    ]
  };

  const paymentRes = await fetch(
    "https://pci.zcredit.co.il/WebCheckout/api/WebCheckout/CreateSession",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const text = await paymentRes.text();
  console.log("ZCredit RAW:", text);

  let paymentData;
  try {
    paymentData = JSON.parse(text);
  } catch {
    throw new Error("ZCredit returned invalid JSON");
  }

  const url = paymentData?.Data?.SessionUrl || paymentData?.SessionUrl;

  if (!url) {
    throw new Error("ZCredit לא החזיר קישור תשלום: " + JSON.stringify(paymentData));
  }

  return url;
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "test-order.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL
  });
});

app.get("/api/menu", async (req, res) => {
  try {
    const r = await fetch(`${APPS_SCRIPT_URL}?action=menu`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/order", async (req, res) => {
  try {
    const order = req.body || {};

    const clientName = String(order.clientName || "").trim();
    const phone = normalizePhoneLocal(order.phone || "");
    const items = Array.isArray(order.items) ? order.items : [];
    const total = parseAmount(order.total);
    const paymentMethod = String(order.paymentMethod || "").trim();

    if (!clientName) throw new Error("Missing clientName");
    if (!phone) throw new Error("Missing phone");
    if (!items.length) throw new Error("Cart is empty");
    if (!total) throw new Error("Invalid total");
    if (!paymentMethod) throw new Error("Missing paymentMethod");

    const reserve = await callAppsScript("reserveOrder", {
      clientName,
      phone,
      source: "new_order_system"
    });

    const orderNo = reserve.orderNo;

    const fullOrder = {
      ...order,
      orderNo,
      clientName,
      phone,
      total,
      createdAt: new Date().toISOString()
    };

    if (paymentMethod === "credit") {
      await callAppsScript("savePendingOrder", {
        orderNo,
        order: { ...fullOrder, orderStatus: "pending" }
      });

      const paymentUrl = await createZCreditSession({
        orderNo,
        amount: total,
        name: clientName,
        phone
      });

      return res.json({ ok: true, orderNo, paymentUrl });
    }

    await callAppsScript("savePendingOrder", {
      orderNo,
      order: { ...fullOrder, orderStatus: "approved" }
    });

    res.json({ ok: true, orderNo });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.all("/zc-callback", async (req, res) => {
  try {
    const body = req.method === "GET" ? req.query : req.body;
    const token = String(body.UniqueID || body.UniqueId || "").trim();
    const approvalNumber = String(body.ApprovalNumber || body.ApprovalNum || "").trim();

    if (approvalNumber) {
      await callAppsScript("paymentPaid", {
        token,
        approvalNumber,
        raw: body
      });
    }
  } catch (err) {
    console.error("zc-callback error:", err.message);
  }

  res.send("OK");
});

app.get("/payment-success", (req, res) => {
  const orderId = cleanDigits(req.query.orderId || "");
  res.send(`<h1>התשלום עבר ✔️</h1><h2>${orderId}</h2>`);
});

app.get("/payment-cancel", (req, res) => {
  const orderId = cleanDigits(req.query.orderId || "");
  res.send(`<h1>התשלום בוטל ❌</h1><h2>${orderId}</h2>`);
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
  console.log("🌐 BASE_URL:", BASE_URL);
});
