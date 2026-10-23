
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase Admin using Render's private environment variable.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require(path.resolve(
      __dirname,
      "..",
      "aquapure-3d28b-firebase-adminsdk-fbsvc-e819c2ae7a.json"
    ));

const firebaseApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount),
      });

const firebaseAuth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get("/", (req, res) => {
  res.json({ message: "AquaPure payment server is running" });
});

// Verify the Firebase user token sent by the app.
async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Login required" });
    }

    req.user = await firebaseAuth.verifyIdToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired login" });
  }
}

// Create a Razorpay order using prices from Firestore, never client prices.
app.post("/create-order", authenticate, async (req, res) => {
  try {
    const { items, customerName, phone, address } = req.body;

    if (
      typeof customerName !== "string" ||
      !customerName.trim() ||
      typeof phone !== "string" ||
      !/^[6-9]\d{9}$/.test(phone) ||
      typeof address !== "string" ||
      !address.trim() ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 50
    ) {
      return res.status(400).json({
        error: "Valid delivery details and cart items are required",
      });
    }

    const userSnapshot = await db
      .collection("users")
      .doc(req.user.uid)
      .get();

    if (!userSnapshot.exists) {
      return res.status(403).json({ error: "User profile not found" });
    }

    const userData = userSnapshot.data();

    const approvedDealer =
      userData.role === "dealer" &&
      userData.dealerStatus === "approved";

    const orderItems = [];
    let totalPaise = 0;
    const seenIds = new Set();

    for (const item of items) {
      const productId =
        typeof item.productId === "string" ? item.productId : "";
      const quantity = item.quantity;

      if (
        !productId ||
        seenIds.has(productId) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 999
      ) {
        return res.status(400).json({
          error: "Invalid product or quantity",
        });
      }

      seenIds.add(productId);

      const productSnapshot = await db
        .collection("products")
        .doc(productId)
        .get();

      if (!productSnapshot.exists) {
        return res.status(400).json({
          error: "A product is no longer available",
        });
      }

      const product = productSnapshot.data();
      const price = Number(
        approvedDealer ? product.dealerPrice : product.price
      );

      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
          error: "Invalid price for a product",
        });
      }

      const unitPaise = Math.round(price * 100);
      const subtotalPaise = unitPaise * quantity;

      if (
        !Number.isSafeInteger(unitPaise) ||
        !Number.isSafeInteger(subtotalPaise)
      ) {
        return res.status(400).json({ error: "Invalid order amount" });
      }

      totalPaise += subtotalPaise;

      orderItems.push({
        productId,
        name: String(product.name || "Product"),
        price: unitPaise / 100,
        quantity,
        subtotal: subtotalPaise / 100,
      });
    }

    if (
      !Number.isSafeInteger(totalPaise) ||
      totalPaise <= 0 ||
      totalPaise > 100000000
    ) {
      return res.status(400).json({ error: "Order total is invalid" });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: "INR",
      receipt: `aq_${Date.now()}`,
    });

    // Store the trusted checkout data on the server.
    await db.collection("paymentCheckouts").doc(razorpayOrder.id).set({
      userId: req.user.uid,
      customerName: customerName.trim(),
      email: req.user.email || "",
      phone,
      address: address.trim(),
      items: orderItems,
      total: totalPaise / 100,
      amountPaise: totalPaise,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({
      orderId: razorpayOrder.id,
      amount: totalPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      customerName: customerName.trim(),
      email: req.user.email || "",
      phone,
    });
  } catch (error) {
    console.error("Create order failed:", error.message);
    res.status(500).json({ error: "Could not create payment order" });
  }
});

// Verify the callback and create the paid Firestore order server-side.
app.post("/razorpay-callback", async (req, res) => {
  let result = {
    type: "RAZORPAY_RESULT",
    success: false,
    message: "Payment could not be verified.",
  };

  try {
    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body;

    if (!orderId || !paymentId || !signature) {
      throw new Error("Missing payment details");
    }

    const checkoutRef = db.collection("paymentCheckouts").doc(orderId);
    const checkoutSnapshot = await checkoutRef.get();

    if (!checkoutSnapshot.exists) {
      throw new Error("Checkout not found");
    }

    const checkout = checkoutSnapshot.data();

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest();

    const receivedSignature = Buffer.from(signature, "hex");

    if (
      expectedSignature.length !== receivedSignature.length ||
      !crypto.timingSafeEqual(expectedSignature, receivedSignature)
    ) {
      throw new Error("Invalid payment signature");
    }

    const [payment, razorpayOrder] = await Promise.all([
      razorpay.payments.fetch(paymentId),
      razorpay.orders.fetch(orderId),
    ]);

    if (
      payment.order_id !== orderId ||
      payment.status !== "captured" ||
      payment.amount !== checkout.amountPaise ||
      payment.amount !== razorpayOrder.amount ||
      payment.currency !== "INR" ||
      razorpayOrder.currency !== "INR"
    ) {
      throw new Error("Payment details do not match");
    }

    // Use a transaction to avoid creating duplicate orders on retries.
    const orderRef = await db.runTransaction(async (transaction) => {
      const freshCheckout = await transaction.get(checkoutRef);

      if (!freshCheckout.exists) {
        throw new Error("Checkout no longer exists");
      }

      const freshData = freshCheckout.data();

      if (freshData.status === "paid" && freshData.orderDocumentId) {
        return db.collection("orders").doc(freshData.orderDocumentId);
      }

      if (freshData.status !== "pending") {
        throw new Error("Checkout is not pending");
      }

      const newOrderRef = db.collection("orders").doc();

      transaction.set(newOrderRef, {
        userId: freshData.userId,
        customerName: freshData.customerName,
        email: freshData.email,
        phone: freshData.phone,
        address: freshData.address,
        items: freshData.items,
        total: freshData.total,
        paymentMethod: "Razorpay",
        paymentStatus: "paid",
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        status: "placed",
        createdAt: FieldValue.serverTimestamp(),
      });

      transaction.update(checkoutRef, {
        status: "paid",
        orderDocumentId: newOrderRef.id,
        razorpayPaymentId: paymentId,
        verifiedAt: FieldValue.serverTimestamp(),
      });

      return newOrderRef;
    });

    result = {
      type: "RAZORPAY_RESULT",
      success: true,
      orderId: orderRef.id,
      paymentId,
      message: "Payment verified and order recorded.",
    };
  } catch (error) {
    console.error("Payment callback failed:", error.message);
  }

  // Return a page that can communicate with React Native WebView.
  const payload = JSON.stringify(JSON.stringify(result));
  const heading = result.success
    ? "Payment verified"
    : "Payment not verified";

  res.status(200).type("html").send(`
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>AquaPure Payment</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:32px">
        <h2>${heading}</h2>
        <p>${result.success
          ? "Your order has been recorded. Return to AquaPure."
          : "Return to AquaPure to check the payment status."}</p>
        <script>
          (function () {
            var message = ${payload};
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(message);
            }
          })();
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AquaPure payment server running on port ${PORT}`);
});
