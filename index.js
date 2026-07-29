require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Session Check Middleware to enforce single device login
const checkSession = async (req, res, next) => {
  const sessionId = req.headers['x-session-id'] || req.body.sessionId || req.query.sessionId;
  const restId = req.headers['x-rest-id'] || req.body.restId || req.body.restaurantId || req.params.restaurantId;

  if (sessionId && restId) {
    try {
      const user = await User.findOne({ restId }).lean();
      if (user && user.currentSessionId && user.currentSessionId !== sessionId) {
        return res.status(401).json({ 
          success: false, 
          code: "SESSION_EXPIRED", 
          message: "Logged in on another device" 
        });
      }
    } catch (err) {
      console.error("Session middleware error:", err.message);
    }
  }
  next();
};

// Initialize Firebase Admin dynamically
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully via FIREBASE_SERVICE_ACCOUNT");
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY
      .replace(/^"|"$/g, '')
      .replace(/\\n/g, '\n');
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      })
    });
    console.log("Firebase Admin SDK initialized successfully via individual environment variables");
  } else {
    const fs = require('fs');
    const path = require('path');
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      initializeApp({
        credential: cert(serviceAccount)
      });
      console.log("Firebase Admin SDK initialized successfully via serviceAccountKey.json");
    } else {
      console.warn("Firebase credentials not found. Push notifications will not function in production.");
    }
  }
} catch (error) {
  console.error("Error initializing Firebase Admin SDK:", error);
}

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB Atlas successfully");
    startOrderListener();
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

    // Generate new Session ID for single-device session enforcement
    const sessionId = crypto.randomUUID();
    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: { currentSessionId: sessionId } },
      { returnDocument: 'after' }
    ).lean();

    // Exclude password from the returned user details
    const { password: _, ...userData } = updatedUser || user;
    userData.sessionId = sessionId;

    return res.status(200).json({ 
      success: true, 
      message: "Login successful",
      sessionId: sessionId,
      user: userData
    });
  } catch (err) {
    console.error("Login route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Signup Endpoint
app.post('/signup', async (req, res) => {
  const { email, password, restId } = req.body;

  if (!email || !password || !restId) {
    return res.status(400).json({ success: false, message: "Email, password, and restId are required" });
  }

  try {
    // Check if user already exists with this email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "User already exists with this email" });
    }

    // Check if restId is already taken
    const existingRest = await User.findOne({ restId });
    if (existingRest) {
      return res.status(400).json({ success: false, message: "Restaurant ID is already registered" });
    }

    // Create new user
    const newUser = new User({
      email,
      password,
      restId
    });

    await newUser.save();

    // Exclude password from the returned user details
    const { password: _, ...userData } = newUser.toObject();

    return res.status(201).json({
      success: true,
      message: "Signup successful",
      user: userData
    });
  } catch (err) {
    console.error("Signup route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Update FCM Token Endpoint (registers fcmToken on login, clears/deletes fcmToken on logout)
app.post('/update-fcm', async (req, res) => {
  const { restId, fcmToken } = req.body;

  if (!restId) {
    return res.status(400).json({ success: false, message: "restId is required" });
  }

  try {
    const tokenValue = fcmToken || "";

    // Check if an old FCM token exists for a different device before updating
    const existingUser = await User.findOne({ restId: restId }).lean();
    if (existingUser && existingUser.fcmToken && tokenValue && existingUser.fcmToken !== tokenValue) {
      console.log(`Sending silent FORCE_LOGOUT notification to previous device FCM token for Restaurant: ${restId}`);
      try {
        const logoutPayload = {
          token: existingUser.fcmToken,
          data: {
            action: 'FORCE_LOGOUT',
            message: 'Your account was logged in from another device.'
          },
          android: {
            priority: 'high'
          }
        };
        await getMessaging().send(logoutPayload);
        console.log("Silent FORCE_LOGOUT notification dispatched successfully.");
      } catch (fcmErr) {
        console.error("Error dispatching silent FORCE_LOGOUT notification:", fcmErr.message);
      }
    }

    // If fcmToken is null, undefined, or empty string, it clears/deletes the token in the DB
    const result = await User.findOneAndUpdate(
      { restId: restId },
      { $set: { fcmToken: tokenValue } },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ success: false, message: "Restaurant user not found" });
    }

    console.log(`FCM token successfully ${tokenValue ? 'registered' : 'cleared'} for Restaurant: ${restId}`);
    return res.status(200).json({ 
      success: true, 
      message: `FCM token successfully ${tokenValue ? 'registered' : 'cleared'}`,
      data: { restId: result.restId, hasToken: !!result.fcmToken }
    });
  } catch (err) {
    console.error("Error updating FCM token:", err);
    return res.status(500).json({ success: false, message: "Internal server error", error: err.message });
  }
});

// Verify Session Endpoint
app.post('/verify-session', async (req, res) => {
  const { restId, sessionId } = req.body;
  if (!restId || !sessionId) {
    return res.status(400).json({ success: false, message: "restId and sessionId are required" });
  }
  try {
    const user = await User.findOne({ restId }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "Restaurant user not found" });
    }
    if (user.currentSessionId && user.currentSessionId !== sessionId) {
      return res.status(401).json({ 
        success: false, 
        code: "SESSION_EXPIRED", 
        message: "Your account was logged in from another device." 
      });
    }
    return res.status(200).json({ success: true, message: "Session valid" });
  } catch (err) {
    console.error("Verify session error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Toggle Status Endpoint
// Updates isActive directly on the restaurant user document in restuarentusers collection
app.post('/toggle-status', async (req, res) => {
  const { restaurantId, isActive } = req.body;

  if (!restaurantId || isActive === undefined) {
    return res.status(400).json({ success: false, message: "restaurantId and isActive are required" });
  }

  try {
    const updatedUser = await User.findOneAndUpdate(
      { restId: restaurantId },
      { 
        $set: { 
          isActive: isActive,
          statusUpdatedAt: new Date()
        } 
      },
      { returnDocument: 'after' }
    );

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "Restaurant user not found" });
    }

    console.log(`Restaurant ${restaurantId} isActive set to ${isActive} in restuarentusers`);
    return res.status(200).json({ 
      success: true, 
      message: "Status updated successfully", 
      isActive: updatedUser.isActive 
    });
  } catch (err) {
    console.error("Toggle status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get Status Endpoint
// Reads isActive directly from the restaurant user document in restuarentusers collection
app.get('/get-status/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const user = await User.findOne({ restId: restaurantId }).lean();
    if (!user) {
      return res.status(200).json({ success: true, isActive: false });
    }
    // Default to true (open) if isActive has never been set on this user document
    const isActive = user.isActive !== undefined ? user.isActive : true;
    return res.status(200).json({ success: true, isActive });
  } catch (err) {
    console.error("Get status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Get all items in itemstatus / restaurant collections for a restaurant
app.get('/itemstatus/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  const targetId = String(restaurantId);

  try {
    const client = mongoose.connection.client;
    let items = [];

    // 1. Search in 'test' database -> 'itemstatus' collection
    try {
      const testDb = client.db('test');
      const testItems = await testDb.collection('itemstatus')
        .find({ $or: [{ restaurantId: targetId }, { restId: targetId }] })
        .project({ photoUrl: 0, photo: 0, image: 0, img: 0, imageUrl: 0 })
        .toArray();
      if (testItems && testItems.length > 0) {
        items = items.concat(testItems);
      }
    } catch (e) {
      console.error("Error querying test.itemstatus:", e.message);
    }

    // 2. Search in 'restuarents' database across all collections
    try {
      const restDb = client.db('restuarents');
      const collections = await restDb.listCollections().toArray();
      for (const coll of collections) {
        const collItems = await restDb.collection(coll.name)
          .find({ $or: [{ restaurantId: targetId }, { restId: targetId }] })
          .project({ photoUrl: 0, photo: 0, image: 0, img: 0, imageUrl: 0 })
          .toArray();
        if (collItems && collItems.length > 0) {
          items = items.concat(collItems);
        }
      }
    } catch (e) {
      console.error("Error querying restuarents db collections:", e.message);
    }

    // 3. Fallback search in default database
    if (items.length === 0) {
      try {
        const defaultDb = mongoose.connection.db;
        const defaultItems = await defaultDb.collection('itemstatus')
          .find({ $or: [{ restaurantId: targetId }, { restId: targetId }] })
          .project({ photoUrl: 0, photo: 0, image: 0, img: 0, imageUrl: 0 })
          .toArray();
        if (defaultItems && defaultItems.length > 0) {
          items = items.concat(defaultItems);
        }
      } catch (e) {}
    }

    // Standardize returned items (excluding photos, retrieving itemName, price, itemStatus)
    const formattedItems = (items || []).map(item => ({
      ...item,
      itemName: item.itemName || item.name || item.title || "Unnamed Item",
      price: item.price !== undefined ? item.price : (item.itemPrice || 0),
      itemStatus: item.itemStatus !== undefined ? Boolean(item.itemStatus) : (item.isAvailable !== undefined ? Boolean(item.isAvailable) : true)
    }));

    return res.status(200).json({ success: true, items: formattedItems });
  } catch (err) {
    console.error("Fetch itemstatus error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Toggle the status of a specific item across databases & collections
app.post('/toggle-itemstatus', async (req, res) => {
  const { itemId, itemStatus, restId } = req.body;
  if (!itemId || itemStatus === undefined) {
    return res.status(400).json({ success: false, message: "itemId and itemStatus are required" });
  }
  try {
    const client = mongoose.connection.client;
    let objectId;
    try {
      objectId = new mongoose.Types.ObjectId(itemId);
    } catch (e) {
      objectId = itemId;
    }

    let updated = false;

    // 1. Try updating in 'test' db -> 'itemstatus' collection
    try {
      const testDb = client.db('test');
      const resTest = await testDb.collection('itemstatus').updateOne(
        { $or: [{ _id: objectId }, { _id: itemId }, { itemId: itemId }] },
        { $set: { itemStatus, updatedAt: new Date() } }
      );
      if (resTest.matchedCount > 0) updated = true;
    } catch (e) {}

    // 2. Try updating in 'restuarents' db collections
    try {
      const restDb = client.db('restuarents');
      const collections = await restDb.listCollections().toArray();
      for (const coll of collections) {
        const resRest = await restDb.collection(coll.name).updateOne(
          { $or: [{ _id: objectId }, { _id: itemId }, { itemId: itemId }] },
          { $set: { itemStatus, updatedAt: new Date() } }
        );
        if (resRest.matchedCount > 0) updated = true;
      }
    } catch (e) {}

    return res.status(200).json({ success: true, message: "Item status updated successfully", updated });
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
      { returnDocument: 'after' }
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
      const commRate = (order.commissionRate !== undefined && order.commissionRate !== null)
        ? Number(order.commissionRate)
        : 12;
      const price = (order.netEarnings !== undefined && order.netEarnings !== null)
        ? Number(order.netEarnings)
        : Number(order.totalPrice || 0) * (1 - commRate / 100);
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

// Restaurant Stats Endpoint (calculates earnings and order counts from acceptedbyrestorents)
app.get('/restaurant-stats/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;

  try {
    const orders = await mongoose.connection.db.collection('acceptedbyrestorents')
      .find({ restaurantId })
      .toArray();

    // Fetch restaurant user commission from DB
    let defaultRestComm = 12;
    try {
      const testDb = mongoose.connection.client.db("test");
      const rUser = await testDb.collection('restuarentusers').findOne({
        $or: [
          { restId: String(restaurantId) },
          { restId: Number(restaurantId) },
          { restaurantId: String(restaurantId) },
          { restaurantId: Number(restaurantId) }
        ]
      });
      if (rUser && rUser.commission !== undefined && rUser.commission !== null) {
        defaultRestComm = Number(rUser.commission);
      }
    } catch (e) {
      // Ignored
    }

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
      const commRate = (order.commissionRate !== undefined && order.commissionRate !== null)
        ? Number(order.commissionRate)
        : defaultRestComm;
      const price = (order.netEarnings !== undefined && order.netEarnings !== null)
        ? Number(order.netEarnings)
        : Number(order.totalPrice || 0) * (1 - commRate / 100);
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

    // Step B: Fetch Restaurant User Commission from DB & Calculate Payout
    let restUser = null;
    if (order.restaurantId) {
      try {
        const testDb = mongoose.connection.client.db("test");
        restUser = await testDb.collection('restuarentusers').findOne({
          $or: [
            { restId: String(order.restaurantId) },
            { restId: Number(order.restaurantId) },
            { restaurantId: String(order.restaurantId) },
            { restaurantId: Number(order.restaurantId) },
            { _id: String(order.restaurantId) }
          ]
        });
      } catch (e) {
        // Ignored
      }
      if (!restUser) {
        try {
          restUser = await mongoose.connection.db.collection('restuarentusers').findOne({
            $or: [
              { restId: String(order.restaurantId) },
              { restId: Number(order.restaurantId) },
              { restaurantId: String(order.restaurantId) },
              { restaurantId: Number(order.restaurantId) }
            ]
          });
        } catch (e) {
          // Ignored
        }
      }
    }

    const commissionRate = (restUser && restUser.commission !== undefined && restUser.commission !== null)
      ? Number(restUser.commission)
      : 12; // default 12% commission

    const rawTotalPrice = Number(order.totalPrice || 0);
    const commissionAmount = Number((rawTotalPrice * (commissionRate / 100)).toFixed(2));
    const netEarnings = Number((rawTotalPrice - commissionAmount).toFixed(2));

    // Exclude _id and __v from the original order to prevent duplicate keys on insert
    const { _id, __v, ...orderData } = order;

    const newEntryData = {
      ...orderData,
      userName: userDetails.userName,
      userEmail: userDetails.userEmail,
      userPhone: userDetails.userPhone,
      rest: rest || order.deliveryAddress || "Unknown",
      restaurantLocation: restaurantLocation || {},
      status: 'accepted',
      commissionRate: commissionRate,
      commissionAmount: commissionAmount,
      netEarnings: netEarnings,
      totalPriceAfterCommission: netEarnings
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

    // 3. Record / Update Payouts in PendingPayment Collection (pendingpayments) using net earnings after commission cut
    await mongoose.connection.db.collection('pendingpayments').updateOne(
      { restaurantId: String(order.restaurantId) },
      { 
        $inc: { 
          grandTotal: netEarnings,
          grossTotal: rawTotalPrice,
          totalCommissionCut: commissionAmount
        },
        $set: { 
          restaurantName: order.restaurantName || "Unknown", 
          commissionRate: commissionRate,
          date: new Date() 
        }
      },
      { upsert: true }
    );

   
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

// Order Stream Listener to automatically trigger push notifications
function startOrderListener() {
  const db = mongoose.connection.db;
  const orderCollection = db.collection('orders');

  console.log("Setting up MongoDB Order watch change stream...");

  let changeStream;
  try {
    changeStream = orderCollection.watch([
      { $match: { operationType: 'insert' } }
    ]);

    changeStream.on('change', async (change) => {
      const newOrder = change.fullDocument;
      console.log("🔥 NEW ORDER DETECTED:", newOrder.orderId || newOrder._id);

      const targetRestaurantId = newOrder.restaurantId;
      if (targetRestaurantId) {
        // Find the restaurant in 'restuarentusers' to get its fcmToken
        const restaurant = await User.findOne({ restId: targetRestaurantId });
        if (restaurant && restaurant.fcmToken) {
          console.log(`Found Restaurant: ${restaurant.email} (ID: ${targetRestaurantId}), dispatching notification...`);
          await sendPushNotification(restaurant.fcmToken, newOrder);
        } else {
          console.log(`No registered fcmToken found for Restaurant ID: ${targetRestaurantId}`);
        }
      }
    });

    changeStream.on('error', (err) => {
      console.error("Order change stream listener error:", err.message || err);
    });
  } catch (error) {
    console.error("Failed to start MongoDB change stream watch:", error.message || error);
  }
}

// Helper function to send Firebase notification
async function sendPushNotification(fcmToken, order) {
  const message = {
    token: fcmToken,
    notification: {
      title: 'New Order Received! 🍔',
      body: `Order #${order.orderId || String(order._id).slice(-4)} has been placed for ₹${order.totalPrice || order.grandTotal || 0}.`,
    },
    data: {
      orderId: String(order._id),
      action: 'open_order'
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'order_notifications',
        sound: 'ordernotification',
        priority: 'max',
        visibility: 'public'
      }
    }
  };

  try {
    const response = await getMessaging().send(message);
    console.log('Firebase notification successfully dispatched:', response);
  } catch (error) {
    console.error('Error dispatching Firebase notification:', error);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});