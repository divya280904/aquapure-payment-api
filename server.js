
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const {
  sendEmail,
  sendSMS,
  getOrderPlacedEmailTemplate,
  getOrderStatusUpdateEmailTemplate,
  getServiceBookingEmailTemplate,
  getServiceStatusUpdateEmailTemplate,
} = require("./notifications");

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

// Helper to deliver push notification via Expo
async function sendExpoPush(token, title, body, data = {}) {
  if (
    typeof token !== "string" ||
    !/^Expo(nent)?PushToken\[.+\]$/.test(token)
  ) {
    return false;
  }
  try {
    const expoResponse = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        title,
        body,
        channelId: "default",
        sound: "default",
        data,
      }),
    });
    const result = await expoResponse.json();
    return expoResponse.ok && result?.data?.status === "ok";
  } catch (err) {
    console.error("Expo push notification failed:", err.message);
    return false;
  }
}

// Helper to notify customer on order placement (Push, Email, SMS)
async function notifyOrderPlaced(orderId, orderData) {
  try {
    const { userId, customerName, email, phone, items, total, address, paymentMethod } = orderData;
    let pushToken = "";

    if (userId) {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) {
        pushToken = userDoc.data()?.expoPushToken || "";
      }
    }

    // 1. Email notification
    if (email) {
      sendEmail({
        to: email,
        subject: `AquaPure Order Confirmed #${orderId.slice(-8)}`,
        html: getOrderPlacedEmailTemplate({
          orderId,
          customerName,
          items,
          total,
          address,
          paymentMethod,
        }),
      }).catch((e) => console.error("Order placed email error:", e.message));
    }

    // 2. SMS notification
    if (phone) {
      sendSMS({
        phone,
        message: `AquaPure: Your order #${orderId.slice(-8)} (₹${total}) has been placed successfully! Payment: ${paymentMethod || "COD"}. Track in AquaPure app.`,
      }).catch((e) => console.error("Order placed SMS error:", e.message));
    }

    // 3. Expo Push notification
    if (pushToken) {
      sendExpoPush(
        pushToken,
        "Order Confirmed!",
        `Your order #${orderId.slice(-8)} has been placed successfully.`,
        { type: "order_placed", orderId }
      ).catch((e) => console.error("Order placed push error:", e.message));
    }
  } catch (err) {
    console.error("notifyOrderPlaced failed:", err.message);
  }
}

// Helper to notify customer on service booking (Push, Email, SMS)
async function notifyServiceBooked(requestId, serviceData) {
  try {
    const { userId, customerName, email, phone, serviceType, preferredDate, address } = serviceData;
    let pushToken = "";

    if (userId) {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) {
        pushToken = userDoc.data()?.expoPushToken || "";
      }
    }

    // 1. Email notification
    if (email) {
      sendEmail({
        to: email,
        subject: `AquaPure Service Booked #${requestId.slice(-8)} (${serviceType})`,
        html: getServiceBookingEmailTemplate({
          requestId,
          customerName,
          serviceType,
          preferredDate,
          address,
        }),
      }).catch((e) => console.error("Service booking email error:", e.message));
    }

    // 2. SMS notification
    if (phone) {
      sendSMS({
        phone,
        message: `AquaPure: Your request for ${serviceType} (#${requestId.slice(-8)}) has been confirmed. Our technician will contact you shortly.`,
      }).catch((e) => console.error("Service booking SMS error:", e.message));
    }

    // 3. Expo Push notification
    if (pushToken) {
      sendExpoPush(
        pushToken,
        "Service Request Received",
        `Your ${serviceType} request #${requestId.slice(-8)} has been confirmed.`,
        { type: "service_booked", requestId }
      ).catch((e) => console.error("Service booking push error:", e.message));
    }
  } catch (err) {
    console.error("notifyServiceBooked failed:", err.message);
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

    // Trigger multi-channel confirmation asynchronously
    orderRef.get().then((snap) => {
      if (snap.exists) {
        notifyOrderPlaced(orderRef.id, snap.data()).catch((e) =>
          console.error("Razorpay order notification dispatch failed:", e.message)
        );
      }
    }).catch((e) => console.error("Error reading verified order:", e.message));
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


app.post("/admin/order-status", authenticate, async (req, res) => {
  try {
    // Only administrators may change order status.
    if (req.user.admin !== true) {
      return res.status(403).json({
        error: "Admin permission is required",
      });
    }

    const { orderId, status } = req.body;

    if (
      typeof orderId !== "string" ||
      !orderId.trim() ||
      typeof status !== "string" ||
      !status.trim() ||
      status.length > 40
    ) {
      return res.status(400).json({
        error: "Valid order ID and status are required",
      });
    }

    const orderRef = db.collection("orders").doc(orderId.trim());
    const orderSnapshot = await orderRef.get();

    if (!orderSnapshot.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderSnapshot.data();
    const previousStatus = order.status;

    if (previousStatus === status.trim()) {
      return res.json({
        success: true,
        notificationSent: false,
        message: "Order already has this status",
      });
    }

    // Update the order on the trusted server.
    await orderRef.update({
      status: status.trim(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Retrieve customer information for multi-channel notification.
    const userId = order.userId;
    let pushToken = "";
    let customerEmail = order.email;
    let customerPhone = order.phone;
    let customerName = order.customerName;

    if (userId) {
      const userSnapshot = await db.collection("users").doc(userId).get();
      if (userSnapshot.exists) {
        const userData = userSnapshot.data();
        pushToken = userData.expoPushToken || "";
        customerEmail = customerEmail || userData.email;
        customerPhone = customerPhone || userData.phone;
        customerName = customerName || userData.name;
      }
    }

    // 1. Expo Push notification
    const notificationSent = await sendExpoPush(
      pushToken,
      "AquaPure Order Update",
      `Your order status is now ${status.trim()}.`,
      {
        type: "order_status_update",
        orderId: orderRef.id,
        status: status.trim(),
      }
    );

    // 2. Email notification
    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `AquaPure Order Update: #${orderRef.id.slice(-8)} is now ${status.trim()}`,
        html: getOrderStatusUpdateEmailTemplate({
          orderId: orderRef.id,
          customerName,
          newStatus: status.trim(),
        }),
      }).catch((e) => console.error("Order status update email error:", e.message));
    }

    // 3. SMS notification
    if (customerPhone) {
      sendSMS({
        phone: customerPhone,
        message: `AquaPure: Your order #${orderRef.id.slice(-8)} status is now "${status.trim()}". Check My Orders in app for details.`,
      }).catch((e) => console.error("Order status update SMS error:", e.message));
    }

    return res.json({
      success: true,
      notificationSent,
      message: notificationSent
        ? "Order updated and notification sent"
        : "Order updated successfully",
    });
  } catch (error) {
    console.error("Order status update failed:", error.message);
    return res.status(500).json({
      error: "Could not update order status",
    });
  }
});

// Update Service Request status (Admin only) with multi-channel notification
app.post("/admin/service-status", authenticate, async (req, res) => {
  try {
    if (req.user.admin !== true) {
      return res.status(403).json({ error: "Admin permission is required" });
    }

    const { requestId, status } = req.body;
    if (
      typeof requestId !== "string" ||
      !requestId.trim() ||
      typeof status !== "string" ||
      !status.trim() ||
      status.length > 40
    ) {
      return res.status(400).json({
        error: "Valid request ID and status are required",
      });
    }

    const serviceRef = db.collection("serviceRequests").doc(requestId.trim());
    const serviceSnapshot = await serviceRef.get();

    if (!serviceSnapshot.exists) {
      return res.status(404).json({ error: "Service request not found" });
    }

    const service = serviceSnapshot.data();
    const previousStatus = service.status;

    if (previousStatus === status.trim()) {
      return res.json({
        success: true,
        notificationSent: false,
        message: "Service request already has this status",
      });
    }

    // Update status server-side
    await serviceRef.update({
      status: status.trim(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const userId = service.userId;
    let pushToken = "";
    let customerEmail = service.email;
    let customerPhone = service.phone;
    let customerName = service.customerName;

    if (userId) {
      const userSnapshot = await db.collection("users").doc(userId).get();
      if (userSnapshot.exists) {
        const userData = userSnapshot.data();
        pushToken = userData.expoPushToken || "";
        customerEmail = customerEmail || userData.email;
        customerPhone = customerPhone || userData.phone;
        customerName = customerName || userData.name;
      }
    }

    // 1. Expo Push notification
    const notificationSent = await sendExpoPush(
      pushToken,
      "AquaPure Service Update",
      `Your ${service.serviceType || "service"} status is now ${status.trim()}.`,
      {
        type: "service_status_update",
        requestId: serviceRef.id,
        status: status.trim(),
      }
    );

    // 2. Email notification
    if (customerEmail) {
      sendEmail({
        to: customerEmail,
        subject: `AquaPure Service Update: #${serviceRef.id.slice(-8)} is now ${status.trim()}`,
        html: getServiceStatusUpdateEmailTemplate({
          requestId: serviceRef.id,
          customerName,
          serviceType: service.serviceType || "Service",
          newStatus: status.trim(),
        }),
      }).catch((e) => console.error("Service status email error:", e.message));
    }

    // 3. SMS notification
    if (customerPhone) {
      sendSMS({
        phone: customerPhone,
        message: `AquaPure: Your service request for ${service.serviceType || "Service"} is now "${status.trim()}".`,
      }).catch((e) => console.error("Service status SMS error:", e.message));
    }

    return res.json({
      success: true,
      notificationSent,
      message: "Service request status updated successfully",
    });
  } catch (error) {
    console.error("Service status update failed:", error.message);
    return res.status(500).json({ error: "Could not update service status" });
  }
});

// Notify on COD order placed
app.post("/notify/order-confirmation", authenticate, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "orderId is required" });
    }

    const orderDoc = await db.collection("orders").doc(orderId.trim()).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const orderData = orderDoc.data();
    if (orderData.userId !== req.user.uid && req.user.admin !== true) {
      return res.status(403).json({ error: "Unauthorized access to order" });
    }

    await notifyOrderPlaced(orderDoc.id, orderData);

    return res.json({
      success: true,
      message: "Order confirmation notifications dispatched",
    });
  } catch (err) {
    console.error("notify/order-confirmation error:", err.message);
    return res.status(500).json({ error: "Failed to dispatch notifications" });
  }
});

// Notify on service booking created
app.post("/notify/service-booking", authenticate, async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId || typeof requestId !== "string") {
      return res.status(400).json({ error: "requestId is required" });
    }

    const requestDoc = await db.collection("serviceRequests").doc(requestId.trim()).get();
    if (!requestDoc.exists) {
      return res.status(404).json({ error: "Service request not found" });
    }

    const serviceData = requestDoc.data();
    if (serviceData.userId !== req.user.uid && req.user.admin !== true) {
      return res.status(403).json({ error: "Unauthorized access to request" });
    }

    await notifyServiceBooked(requestDoc.id, serviceData);

    return res.json({
      success: true,
      message: "Service booking notifications dispatched",
    });
  } catch (err) {
    console.error("notify/service-booking error:", err.message);
    return res.status(500).json({ error: "Failed to dispatch notifications" });
  }
});


const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AquaPure payment server running on port ${PORT}`);
});
