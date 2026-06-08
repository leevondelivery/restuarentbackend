const mongoose = require('mongoose');

mongoose.connect('mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0')
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
