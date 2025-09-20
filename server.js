import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import userRouter from './routes/userRoutes.js';
import connectDB from './configs/mongodb.js';
import imageRouter from './routes/imageRoutes.js';

const PORT = process.env.PORT || 4000;

const app = express();

// Initialize Middlewares
app.use(express.json());
app.use(cors());

// API routes
app.use('/api/user', userRouter);
app.use('/api/image', imageRouter);

// Test route
app.get('/', (req, res) => res.send("API Working"));

// Start server after DB connection
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
console.log("Razorpay ID:", process.env.RAZORPAY_KEY_ID);
console.log("Razorpay SECRET:", process.env.RAZORPAY_KEY_SECRET);
