require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("Connected to DB");

    const orderSchema = new mongoose.Schema({}, { strict: false });
    const FinalCompletedOrder = mongoose.model('FinalCompletedOrder', orderSchema, 'finalcompletedorders');

    const orders = await FinalCompletedOrder.find({}).limit(5).lean();
    console.log("FOUND ORDERS:", JSON.stringify(orders, null, 2));

    mongoose.connection.close();
  })
  .catch(err => {
    console.error("Error", err);
  });
