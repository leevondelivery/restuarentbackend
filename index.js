const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0')
  .then(() => {
    console.log("Connected to MongoDB Atlas successfully");
  })
  .catch(err => console.error("MongoDB connection error:", err));

// User Model (explicitly map to the 'restuarentusers' collection)
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
}, { strict: false });
const User = mongoose.model('User', userSchema, 'restuarentusers');

// Restaurant Status Model
const statusSchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, unique: true },
  isActive: { type: Boolean, required: true },
  isManuallyToggled: { type: Boolean, default: true },
  manualStatusUpdatedAt: { type: Date, default: Date.now }
}, { strict: false });
const RestaurantStatus = mongoose.model('RestaurantStatus', statusSchema, 'restaurantstatuses');

// Login Endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }

  try {
    const user = await User.findOne({ email }).lean();
    if (!user) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    if (user.password !== password) {
      return res.status(400).json({ success: false, message: "Invalid password" });
    }

    // Exclude password from the returned user details
    const { password: _, ...userData } = user;

    return res.status(200).json({ 
      success: true, 
      message: "Login successful",
      user: userData
    });
  } catch (err) {
    console.error("Login route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Toggle Status Endpoint
app.post('/toggle-status', async (req, res) => {
  const { restaurantId, isActive } = req.body;

  if (!restaurantId || isActive === undefined) {
    return res.status(400).json({ success: false, message: "restaurantId and isActive are required" });
  }

  try {
    const status = await RestaurantStatus.findOneAndUpdate(
      { restaurantId },
      { 
        isActive, 
        isManuallyToggled: true,
        manualStatusUpdatedAt: new Date()
      },
      { new: true, upsert: true }
    );

    return res.status(200).json({ success: true, message: "Status updated successfully", status });
  } catch (err) {
    console.error("Toggle status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get Status Endpoint
app.get('/get-status/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const status = await RestaurantStatus.findOne({ restaurantId });
    if (!status) {
      return res.status(200).json({ success: true, isActive: false });
    }
    return res.status(200).json({ success: true, isActive: status.isActive });
  } catch (err) {
    console.error("Get status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Restaurant Stats Endpoint (calculates earnings and order counts from acceptedbyrestorents)
app.get('/restaurant-stats/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const orders = await mongoose.connection.db.collection('acceptedbyrestorents')
      .find({ restaurantId })
      .toArray();

    let totalEarnings = 0;
    let totalOrders = 0;
    let todayEarnings = 0;
    let todayOrders = 0;

    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth();
    const todayDate = today.getDate();

    orders.forEach(order => {
      totalOrders++;
      // Price is totalPrice minus 12% commission
      const price = Number(order.totalPrice || 0) * 0.88;
      totalEarnings += price;

      if (order.orderDate) {
        const oDate = new Date(order.orderDate);
        if (
          oDate.getFullYear() === todayYear &&
          oDate.getMonth() === todayMonth &&
          oDate.getDate() === todayDate
        ) {
          todayOrders++;
          todayEarnings += price;
        }
      }
    });

    return res.status(200).json({
      success: true,
      stats: {
        todayEarnings: parseFloat(todayEarnings.toFixed(2)),
        todayOrders,
        totalEarnings: parseFloat(totalEarnings.toFixed(2)),
        totalOrders
      }
    });
  } catch (err) {
    console.error("Fetch restaurant stats error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});


// Get Restaurant Orders Endpoint
app.get('/restaurant-orders/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const orders = await mongoose.connection.db.collection('acceptedbyrestorents')
      .find({ restaurantId })
      .sort({ orderDate: -1 })
      .toArray();
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("Fetch restaurant orders error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get Accepted Orders Endpoint (from acceptedorders collection)
app.get('/accepted-orders/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const orders = await mongoose.connection.db.collection('acceptedorders')
      .find({ restaurantId })
      .sort({ orderDate: -1 })
      .toArray();
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("Fetch accepted orders error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get Incoming Orders Endpoint (from orders collection in MongoDB)
app.get('/incoming-orders/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const orders = await mongoose.connection.db.collection('orders')
      .find({ restaurantId })
      .sort({ orderDate: -1 })
      .toArray();
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("Fetch incoming orders error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Reject Order Endpoint
app.post('/reject-order', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: "orderId is required" });
  }

  try {
    // 1. Find the order in 'orders' collection
    const order = await mongoose.connection.db.collection('orders').findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found in orders collection" });
    }

    // 2. Prepare the rejected order document
    const rejectedOrder = {
      ...order,
      status: 'rejected',
      rejectedAt: new Date()
    };

    // 3. Insert into 'rejectedorders' collection
    await mongoose.connection.db.collection('rejectedorders').insertOne(rejectedOrder);

    // 4. Delete from 'orders' collection
    await mongoose.connection.db.collection('orders').deleteOne({ orderId });

    // 5. Delete from 'orderstatuses' collection
    await mongoose.connection.db.collection('orderstatuses').deleteOne({ orderId });

    return res.status(200).json({ success: true, message: "Order rejected and moved to rejectedorders" });
  } catch (err) {
    console.error("Reject order error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

