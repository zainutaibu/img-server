import userModel from "../models/userModel.js";
import transactionModel from "../models/transactionModel.js";
import Razorpay from "razorpay";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Stripe from "stripe";

// -----------------
// Initialize Payment Gateways Safely
// -----------------

let razorpayInstance = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.error("❌ Razorpay keys missing in environment variables");
}

let stripeInstance = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log("✅ Stripe initialized");
} else {
  console.error("❌ Stripe secret key missing in environment variables");
}

// -----------------
// User APIs
// -----------------

const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.json({ success: false, message: "Missing Details" });

    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const user = await userModel.create({ name, email, password: hashedPassword });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);

    res.json({ success: true, token, user: { name: user.name } });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await userModel.findOne({ email });
    if (!user) return res.json({ success: false, message: "User does not exist" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.json({ success: false, message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token, user: { name: user.name } });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

const userCredits = async (req, res) => {
  try {
    const user = await userModel.findById(req.body.userId);
    if (!user) return res.json({ success: false, message: "User not found" });
    res.json({ success: true, credits: user.creditBalance, user: { name: user.name } });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

// -----------------
// Razorpay Payment
// -----------------

const paymentRazorpay = async (req, res) => {
  if (!razorpayInstance)
    return res.json({ success: false, message: "Razorpay keys not configured" });

  try {
    const { userId, planId } = req.body;
    const userData = await userModel.findById(userId);
    if (!userData || !planId)
      return res.json({ success: false, message: "Missing Details" });

    let credits, plan, amount;
    switch (planId) {
      case "Basic": plan = "Basic"; credits = 100; amount = 10; break;
      case "Advanced": plan = "Advanced"; credits = 500; amount = 50; break;
      case "Business": plan = "Business"; credits = 5000; amount = 250; break;
      default: return res.json({ success: false, message: "plan not found" });
    }

    const newTransaction = await transactionModel.create({
      userId, plan, amount, credits, date: Date.now()
    });

    const options = {
      amount: amount * 100,
      currency: process.env.CURRENCY,
      receipt: newTransaction._id.toString()
    };

    razorpayInstance.orders.create(options, (error, order) => {
      if (error) return res.json({ success: false, message: error });
      res.json({ success: true, order });
    });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

const verifyRazorpay = async (req, res) => {
  if (!razorpayInstance)
    return res.json({ success: false, message: "Razorpay keys not configured" });

  try {
    const { razorpay_order_id } = req.body;
    const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id);

    if (orderInfo.status !== "paid")
      return res.json({ success: false, message: "Payment Failed" });

    const transactionData = await transactionModel.findById(orderInfo.receipt);
    if (!transactionData) return res.json({ success: false, message: "Transaction not found" });
    if (transactionData.payment)
      return res.json({ success: false, message: "Payment Already Verified" });

    const userData = await userModel.findById(transactionData.userId);
    const creditBalance = userData.creditBalance + transactionData.credits;

    await userModel.findByIdAndUpdate(userData._id, { creditBalance });
    await transactionModel.findByIdAndUpdate(transactionData._id, { payment: true });

    res.json({ success: true, message: "Credits Added" });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

// -----------------
// Stripe Payment
// -----------------

const paymentStripe = async (req, res) => {
  if (!stripeInstance)
    return res.json({ success: false, message: "Stripe key not configured" });

  try {
    const { userId, planId } = req.body;
    const { origin } = req.headers;
    const userData = await userModel.findById(userId);
    if (!userData || !planId)
      return res.json({ success: false, message: "Invalid Credentials" });

    let credits, plan, amount;
    switch (planId) {
      case "Basic": plan = "Basic"; credits = 100; amount = 10; break;
      case "Advanced": plan = "Advanced"; credits = 500; amount = 50; break;
      case "Business": plan = "Business"; credits = 5000; amount = 250; break;
      default: return res.json({ success: false, message: "plan not found" });
    }

    const newTransaction = await transactionModel.create({ userId, plan, amount, credits, date: Date.now() });

    const line_items = [{
      price_data: {
        currency: process.env.CURRENCY.toLowerCase(),
        product_data: { name: "Credit Purchase" },
        unit_amount: amount * 100
      },
      quantity: 1
    }];

    const session = await stripeInstance.checkout.sessions.create({
      success_url: `${origin}/verify?success=true&transactionId=${newTransaction._id}`,
      cancel_url: `${origin}/verify?success=false&transactionId=${newTransaction._id}`,
      line_items,
      mode: "payment"
    });

    res.json({ success: true, session_url: session.url });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

const verifyStripe = async (req, res) => {
  if (!stripeInstance)
    return res.json({ success: false, message: "Stripe key not configured" });

  try {
    const { transactionId, success } = req.body;
    if (success !== "true") return res.json({ success: false, message: "Payment Failed" });

    const transactionData = await transactionModel.findById(transactionId);
    if (!transactionData) return res.json({ success: false, message: "Transaction not found" });
    if (transactionData.payment)
      return res.json({ success: false, message: "Payment Already Verified" });

    const userData = await userModel.findById(transactionData.userId);
    const creditBalance = userData.creditBalance + transactionData.credits;

    await userModel.findByIdAndUpdate(userData._id, { creditBalance });
    await transactionModel.findByIdAndUpdate(transactionData._id, { payment: true });

    res.json({ success: true, message: "Credits Added" });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};

console.log(
  "Razorpay Keys:",
  process.env.RAZORPAY_KEY_ID,
  process.env.RAZORPAY_KEY_SECRET ? "present" : "missing"
);

export {
  registerUser,
  loginUser,
  userCredits,
  paymentRazorpay,
  verifyRazorpay,
  paymentStripe,
  verifyStripe
};
