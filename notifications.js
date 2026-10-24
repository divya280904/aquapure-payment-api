
const nodemailer = require("nodemailer");

// Create reusable transporter if SMTP credentials are provided
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    try {
      transporter = nodemailer.createTransport({
        host: host,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true" || process.env.SMTP_PORT === "465",
        auth: {
          user: user,
          pass: pass,
        },
      });
      console.log("[Email Service] Transporter configured for host:", host);
    } catch (err) {
      console.error("[Email Service] Failed to create transporter:", err.message);
      transporter = null;
    }
  }
  return transporter;
}

/**
 * Send an email notification safely.
 * If credentials are not configured, logs the email in simulation mode without failing.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to || typeof to !== "string" || !to.includes("@")) {
    console.log("[Email Service] Skipped: No valid email address provided.");
    return { success: false, reason: "No valid recipient email" };
  }

  const mailer = getTransporter();
  const from = process.env.SMTP_FROM || '"AquaPure Support" <support@aquapure.com>';

  if (mailer) {
    try {
      const info = await mailer.sendMail({
        from,
        to,
        subject,
        text: text || html.replace(/<[^>]+>/g, ""),
        html,
      });
      console.log("[Email Service] Sent email to:", to, "MessageId:", info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error("[Email Service] Delivery failed to", to, ":", error.message);
      return { success: false, error: error.message };
    }
  } else {
    console.log(
      `[Email Service - Simulated] To: ${to} | Subject: "${subject}"`
    );
    return {
      success: true,
      simulated: true,
      note: "SMTP credentials not set; email simulated cleanly.",
    };
  }
}

/**
 * Send an SMS notification.
 * Supports TextBee gateway API (https://api.textbee.dev) or safe simulation.
 */
async function sendSMS({ phone, message }) {
  if (!phone || typeof phone !== "string") {
    console.log("[SMS Service] Skipped: No phone number provided.");
    return { success: false, reason: "No phone number" };
  }

  // Clean phone number (Indian 10-digit standard)
  const cleanPhone = phone.replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    console.log("[SMS Service] Skipped: Invalid mobile number:", phone);
    return { success: false, reason: "Invalid mobile number" };
  }

  const apiKey = process.env.TEXTBEE_API_KEY;
  const deviceId = process.env.TEXTBEE_DEVICE_ID;
  const smsEnabled = process.env.SMS_ENABLED === "true";

  // If live SMS is enabled and TextBee credentials are provided:
  if (smsEnabled && apiKey && deviceId) {
    try {
      const response = await fetch(
        `https://api.textbee.dev/api/v1/gateway/devices/${deviceId}/send-sms`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            recipients: [`+91${cleanPhone}`],
            message: message,
          }),
        }
      );

      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        console.log("[SMS Service - TextBee] SMS dispatched to +91" + cleanPhone);
        return { success: true, provider: "TextBee", data };
      } else {
        console.error("[SMS Service - TextBee] API error:", data);
        return { success: false, provider: "TextBee", error: data };
      }
    } catch (err) {
      console.error("[SMS Service - TextBee] Network failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  // Safe simulation mode (Default during testing/evaluation to avoid spam & unconsented charges)
  console.log(
    `[SMS Service - Safe Simulated Mode] To: +91${cleanPhone} | Message: "${message}"`
  );
  return {
    success: true,
    simulated: true,
    recipient: `+91${cleanPhone}`,
    note: "SMS simulated safely. Configure TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID, and SMS_ENABLED=true for live carrier delivery.",
  };
}

// ---------------- HTML Email Templates ----------------

function getOrderPlacedEmailTemplate({ orderId, customerName, items, total, address, paymentMethod }) {
  const itemsHtml = (items || [])
    .map(
      (it) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #E2E8F0;">${it.name || "Product"}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #E2E8F0; text-align: center;">${it.quantity}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #E2E8F0; text-align: right;">₹${Number(it.price || 0).toLocaleString("en-IN")}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #E2E8F0; text-align: right; font-weight: bold;">₹${Number(it.subtotal || (it.price * it.quantity) || 0).toLocaleString("en-IN")}</td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #F4FAFC; padding: 24px; color: #173B45;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; border: 1px solid #DCE9ED; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background-color: #087E8B; padding: 24px; text-align: center;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 26px;">AquaPure</h1>
          <p style="color: #DDF5F6; margin: 6px 0 0; font-size: 14px;">Pure Water, Pure Living</p>
        </div>
        <div style="padding: 24px;">
          <h2 style="color: #173B45; font-size: 20px; margin-top: 0;">Order Confirmed!</h2>
          <p>Hello <strong>${customerName || "Customer"}</strong>,</p>
          <p>Thank you for shopping with AquaPure. Your order <strong>#${orderId.slice(-8)}</strong> has been placed successfully.</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
            <thead>
              <tr style="background-color: #E8F4F7; color: #173B45;">
                <th style="padding: 10px 12px; text-align: left;">Product</th>
                <th style="padding: 10px 12px; text-align: center;">Qty</th>
                <th style="padding: 10px 12px; text-align: right;">Price</th>
                <th style="padding: 10px 12px; text-align: right;">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px;">Total Amount:</td>
                <td style="padding: 12px; text-align: right; font-weight: bold; font-size: 16px; color: #087E8B;">₹${Number(total || 0).toLocaleString("en-IN")}</td>
              </tr>
            </tfoot>
          </table>

          <div style="background-color: #F8FBFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin-top: 16px;">
            <p style="margin: 0 0 6px; font-weight: bold; color: #173B45;">Delivery Address:</p>
            <p style="margin: 0; color: #475569;">${address || "Address not provided"}</p>
            <p style="margin: 10px 0 0; font-weight: bold; color: #173B45;">Payment Method: <span style="font-weight: normal; color: #475569;">${paymentMethod || "COD"}</span></p>
          </div>

          <p style="margin-top: 24px; font-size: 13px; color: #64748B; text-align: center;">
            You can track your order status in real time inside the AquaPure mobile app under "My Orders".
          </p>
        </div>
      </div>
    </div>
  `;
}

function getOrderStatusUpdateEmailTemplate({ orderId, customerName, newStatus }) {
  const statusFormatted = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #F4FAFC; padding: 24px; color: #173B45;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; border: 1px solid #DCE9ED;">
        <div style="background-color: #087E8B; padding: 20px; text-align: center;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 24px;">AquaPure Order Update</h1>
        </div>
        <div style="padding: 24px;">
          <p>Hello <strong>${customerName || "Customer"}</strong>,</p>
          <p>Your AquaPure order <strong>#${orderId.slice(-8)}</strong> has an updated status:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="background-color: #087E8B; color: #FFFFFF; padding: 10px 24px; border-radius: 20px; font-weight: bold; font-size: 16px; text-transform: uppercase;">
              ${statusFormatted}
            </span>
          </div>
          <p style="color: #475569; font-size: 14px; text-align: center;">
            We are working hard to deliver pure, healthy drinking water solutions to your doorstep.
          </p>
        </div>
      </div>
    </div>
  `;
}

function getServiceBookingEmailTemplate({ requestId, customerName, serviceType, preferredDate, address }) {
  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #F4FAFC; padding: 24px; color: #173B45;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; border: 1px solid #DCE9ED;">
        <div style="background-color: #087E8B; padding: 20px; text-align: center;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 24px;">AquaPure Service Desk</h1>
          <p style="color: #DDF5F6; margin: 4px 0 0; font-size: 13px;">Service Booking Confirmation</p>
        </div>
        <div style="padding: 24px;">
          <p>Hello <strong>${customerName || "Customer"}</strong>,</p>
          <p>Your service request <strong>#${requestId.slice(-8)}</strong> has been scheduled with our expert technicians.</p>
          
          <div style="background-color: #F8FBFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0 0 6px;"><strong>Service Type:</strong> ${serviceType}</p>
            <p style="margin: 0 0 6px;"><strong>Preferred Date:</strong> ${preferredDate || "As soon as available"}</p>
            <p style="margin: 0 0 6px;"><strong>Location / Address:</strong> ${address}</p>
            <p style="margin: 0;"><strong>Status:</strong> Pending technician assignment</p>
          </div>

          <p style="font-size: 13px; color: #64748B;">Our service engineer will contact you prior to visiting your premises.</p>
        </div>
      </div>
    </div>
  `;
}

function getServiceStatusUpdateEmailTemplate({ requestId, customerName, serviceType, newStatus }) {
  const formatted = newStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #F4FAFC; padding: 24px; color: #173B45;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; border: 1px solid #DCE9ED;">
        <div style="background-color: #087E8B; padding: 20px; text-align: center;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 24px;">AquaPure Service Update</h1>
        </div>
        <div style="padding: 24px;">
          <p>Hello <strong>${customerName || "Customer"}</strong>,</p>
          <p>The status of your <strong>${serviceType}</strong> request (#${requestId.slice(-8)}) has changed to:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="background-color: #087E8B; color: #FFFFFF; padding: 10px 24px; border-radius: 20px; font-weight: bold; font-size: 16px;">
              ${formatted}
            </span>
          </div>
        </div>
      </div>
    </div>
  `;
}

module.exports = {
  sendEmail,
  sendSMS,
  getOrderPlacedEmailTemplate,
  getOrderStatusUpdateEmailTemplate,
  getServiceBookingEmailTemplate,
  getServiceStatusUpdateEmailTemplate,
};
