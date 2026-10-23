
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get("/", (req, res) => {
  res.json({ message: "AquaPure payment server is running" });
});

app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `aquapure_${Date.now()}`,
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Create order failed:", error.message);
    res.status(500).json({ error: "Could not create payment order" });
  }
});


app.post("/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        verified: false,
        error: "Missing payment details",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const signatureBuffer = Buffer.from(expectedSignature, "hex");
    const receivedBuffer = Buffer.from(razorpay_signature, "hex");

    if (
      signatureBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, receivedBuffer)
    ) {
      return res.status(400).json({
        verified: false,
        error: "Invalid payment signature",
      });
    }

    const [payment, order] = await Promise.all([
      razorpay.payments.fetch(razorpay_payment_id),
      razorpay.orders.fetch(razorpay_order_id),
    ]);

    if (
      payment.order_id !== razorpay_order_id ||
      payment.status !== "captured" ||
      payment.amount !== order.amount ||
      payment.currency !== order.currency
    ) {
      return res.status(400).json({
        verified: false,
        error: "Payment is not captured or order details do not match",
      });
    }

    return res.json({
      verified: true,
      paymentId: payment.id,
      orderId: order.id,
      amount: payment.amount,
      currency: payment.currency,
    });
  } catch (error) {
    console.error("Payment verification failed:", error.message);
    return res.status(500).json({
      verified: false,
      error: "Could not verify payment",
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AquaPure payment server running on port ${PORT}`);
});
