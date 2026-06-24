require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
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

// Get all items in itemstatus for a restaurant
app.get('/itemstatus/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const items = await mongoose.connection.db.collection('itemstatus')
      .find({ restaurantId })
      .toArray();
    return res.status(200).json({ success: true, items });
  } catch (err) {
    console.error("Fetch itemstatus error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Toggle the status of a specific item
app.post('/toggle-itemstatus', async (req, res) => {
  const { itemId, itemStatus } = req.body;
  if (!itemId || itemStatus === undefined) {
    return res.status(400).json({ success: false, message: "itemId and itemStatus are required" });
  }
  try {
    let objectId;
    try {
      objectId = new mongoose.Types.ObjectId(itemId);
    } catch (e) {
      objectId = itemId;
    }

    const result = await mongoose.connection.db.collection('itemstatus').updateOne(
      { _id: objectId },
      { $set: { itemStatus, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      // Try matching by raw string id
      const resultRaw = await mongoose.connection.db.collection('itemstatus').updateOne(
        { _id: itemId },
        { $set: { itemStatus, updatedAt: new Date() } }
      );
      if (resultRaw.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "Item not found" });
      }
    }

    return res.status(200).json({ success: true, message: "Item status updated successfully" });
  } catch (err) {
    console.error("Toggle itemstatus error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get Restaurant Profile Endpoint
app.get('/restaurant-profile/:restId', async (req, res) => {
  const { restId } = req.params;
  try {
    const user = await User.findOne({ restId }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "Restaurant user not found" });
    }
    // Remove password
    const { password, ...profileData } = user;
    return res.status(200).json({ success: true, profile: profileData });
  } catch (err) {
    console.error("Fetch restaurant profile error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Update Restaurant Timings Endpoint
app.post('/update-restaurant-timings', async (req, res) => {
  const { restId, openTime, closeTime } = req.body;
  if (!restId) {
    return res.status(400).json({ success: false, message: "restId is required" });
  }
  try {
    const user = await User.findOneAndUpdate(
      { restId },
      { $set: { openTime, closeTime } },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: "Restaurant user not found" });
    }
    return res.status(200).json({ 
      success: true, 
      message: "Timings updated successfully", 
      openTime: user.openTime, 
      closeTime: user.closeTime 
    });
  } catch (err) {
    console.error("Update restaurant timings error:", err);
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

// Get Restaurant Reviews Endpoint
app.get('/restaurant-reviews/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const reviews = await mongoose.connection.db.collection('orderreviews')
      .find({ restaurantId })
      .sort({ createdAt: -1 })
      .toArray();

    // Map reviews to populate userName
    const populatedReviews = await Promise.all(
      reviews.map(async (review) => {
        let userName = "Anonymous Customer";
        if (review.userId) {
          try {
            let user = await mongoose.connection.db.collection('users').findOne({ 
              _id: new mongoose.Types.ObjectId(review.userId) 
            });
            if (!user) {
              user = await mongoose.connection.db.collection('users').findOne({ 
                _id: review.userId 
              });
            }
            if (user) {
              userName = user.name || user.userName || "Customer";
            }
          } catch (e) {
            console.error("Error looking up user details:", e);
          }
        }
        // Look up ordered items by orderId
        let items = [];
        if (review.orderId) {
          try {
            let orderDoc = await mongoose.connection.db.collection('acceptedbyrestorents').findOne({ orderId: review.orderId });
            if (!orderDoc) {
              orderDoc = await mongoose.connection.db.collection('finalorders').findOne({ orderId: review.orderId });
            }
            if (!orderDoc) {
              orderDoc = await mongoose.connection.db.collection('finalcompletedorders').findOne({ orderId: review.orderId });
            }
            if (!orderDoc) {
              orderDoc = await mongoose.connection.db.collection('orders').findOne({ orderId: review.orderId });
            }
            if (orderDoc && orderDoc.items) {
              items = orderDoc.items;
            }
          } catch (e) {
            console.error("Error looking up order items for review:", e);
          }
        }

        return {
          ...review,
          userName,
          items
        };
      })
    );

    return res.status(200).json({ success: true, reviews: populatedReviews });
  } catch (err) {
    console.error("Fetch restaurant reviews error:", err);
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

// Get Rejected Orders Endpoint (from rejectedorders collection in MongoDB)
app.get('/rejected-orders/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  try {
    const orders = await mongoose.connection.db.collection('rejectedorders')
      .find({ restaurantId })
      .sort({ rejectedAt: -1 })
      .toArray();
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("Fetch rejected orders error:", err);
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

// Accept Order Endpoint
app.post('/accept-order', async (req, res) => {
  const { orderId, rest, restaurantLocation } = req.body;
  
  if (!orderId) {
    return res.status(400).json({ success: false, message: "orderId is required" });
  }

  try {
    // Step A: Fetch & Populate Pending Order
    // Try querying by ObjectId first, fallback to raw string
    let order = null;
    try {
      order = await mongoose.connection.db.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    } catch (e) {
      // Ignored
    }
    if (!order) {
      order = await mongoose.connection.db.collection('orders').findOne({ _id: orderId });
    }
    
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found in orders collection" });
    }

    // Retrieve user details from users collection
    let user = null;
    if (order.userId) {
      try {
        user = await mongoose.connection.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(order.userId) });
      } catch (e) {
        // Ignored
      }
      if (!user) {
        user = await mongoose.connection.db.collection('users').findOne({ _id: order.userId });
      }
    }

    const userDetails = {
      userName: user ? (user.name || user.userName || "Unknown") : (order.userName || "Unknown"),
      userEmail: user ? (user.email || "Unknown") : (order.userEmail || "Unknown"),
      userPhone: user ? (user.phone || user.phoneNumber || "Unknown") : (order.userPhone || "Unknown")
    };

    // Step B: Prepare Transfer Data
    // Exclude _id and __v from the original order to prevent duplicate keys on insert
    const { _id, __v, ...orderData } = order;

    const newEntryData = {
      ...orderData,
      userName: userDetails.userName,
      userEmail: userDetails.userEmail,
      userPhone: userDetails.userPhone,
      rest: rest || order.deliveryAddress || "Unknown",
      restaurantLocation: restaurantLocation || {},
      status: 'accepted'
    };

    // Step C: Database Operations (Atomic / Sequential)
    // 1. Upsert into AcceptedOrder Collection (acceptedorders)
    await mongoose.connection.db.collection('acceptedorders').updateOne(
      { orderId: order.orderId },
      { $set: newEntryData },
      { upsert: true }
    );

    // 2. Upsert into AcceptedByRestaurant Collection (acceptedbyrestorents)
    await mongoose.connection.db.collection('acceptedbyrestorents').updateOne(
      { orderId: order.orderId },
      { $set: newEntryData },
      { upsert: true }
    );

    // 3. Record / Update Payouts in PendingPayment Collection (pendingpayments)
    await mongoose.connection.db.collection('pendingpayments').updateOne(
      { restaurantId: order.restaurantId },
      { 
        $inc: { grandTotal: Number(order.totalPrice || 0) },
        $set: { 
          restaurantName: order.restaurantName || "Unknown", 
          date: new Date() 
        }
      },
      { upsert: true }
    );

    // 4. Delete from Pending Collection (orders)
    await mongoose.connection.db.collection('orders').deleteOne({ _id: order._id });

    // 5. Update Status Collection (orderstatuses)
    await mongoose.connection.db.collection('orderstatuses').updateOne(
      { orderId: order.orderId },
      { $set: { status: "Waiting for delivery boy to accept" } }
    );

    // Step D: Trigger Delivery Partner Broadcast (Web Notification) - fire and forget
    fetch('https://deliverymanmain.vercel.app/api/deliveryboy/broadcast-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: "New Order Available! 🛵",
        body: `Order #${order.orderId} is ready for pickup in ${rest || order.deliveryAddress || "Restaurant"}`
      })
    }).catch(err => {
      console.error("Delivery boy broadcast error:", err.message);
    });

    return res.status(200).json({ success: true, message: "Order accepted successfully" });
  } catch (err) {
    console.error("Accept order route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
 
