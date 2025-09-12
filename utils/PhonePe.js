const dotenv = require("dotenv");
const {
  StandardCheckoutClient,
  Env,
  CreateSdkOrderRequest,
  MetaInfo,
  RefundRequest,
} = require("pg-sdk-node");
const {
  getContainer,
  getUserDetails,
  getDetailsById,
} = require("../services/cosmosService");
dotenv.config();
const {
  findOrder,
  getNextOrderId,
  createOrder,
} = require("../services/orderService");
const responseModel = require("../models/ResponseModel");
const {
  subscriptionMessages,
  paymentMessages,
  commonMessages,
  orderMessages,
  authMessage,
  orderCategoriesMap,
  payments,
  msg91Templates,
  msg91TemplateIds,
} = require("../constants");
const axios = require("axios");
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SCERET;
const clientVirtion = 1;
const env = Env.SANDBOX;
const { logger } = require("../jobLogger");
const dayjs = require("dayjs");
const { convertUTCtoIST } = require("./schedules");
const orderContainer = getContainerById("Order");
const subscriptionContainer = getContainerById("Subscriptions");
const storeProductContainer = getContainerById("StoreProduct");
const cartItemContainer = getContainerById("CartItems");
const customerContainer = getContainerById("Customers");
const crypto = require("crypto");
const client = StandardCheckoutClient.getInstance(
  CLIENT_ID,
  CLIENT_SECRET,
  clientVirtion,
  env,
);

const WEBHOOK_USERNAME = process.env.WEBHOOK_USER;
const WEBHOOK_PASSWORD = process.env.WEBHOOK_PASS;

function computeAuthHash() {
  const creds = `${WEBHOOK_USERNAME}:${WEBHOOK_PASSWORD}`;
  return crypto.createHash("sha256").update(creds).digest("hex");
}

async function createPayment(amount, orderId, orderType) {
  const CALLBACK_URL = payments.callBackUrl;
  try {
    const request = CreateSdkOrderRequest.StandardCheckoutBuilder()
      .merchantOrderId(orderId)
      .amount(amount * 100)
      .redirectUrl(CALLBACK_URL)
      .metaInfo(MetaInfo.builder().udf1(orderType).udf2("udf2").build())
      .build();

    const response = await client.createSdkOrder(request);
    return {
      success: true,
      response,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

const handlePaymentStatus = async (req, res) => {
  try {
    const header = req.headers["authorization"];
    const expected = computeAuthHash();

    if (!header || header !== expected) {
      console.warn("Unauthorized webhook call");
      return res.status(401).send("Unauthorized");
    }
    const { payload } = req.body;
    const orderType = payload.metaInfo.udf1;
    const orderId = payload.merchantOrderId;
    const paymentState = payload.state;
    const paymentDetails = payload.paymentDetails;

    if (orderType === orderCategoriesMap.subscriptions) {
      return await handleSubscriptionPayment(
        orderId,
        paymentDetails,
        paymentState,
        payload,
        res,
      );
    }

    return await handleNormalOrderPayment(
      orderId,
      paymentDetails,
      paymentState,
      payload,
      res,
    );
  } catch (error) {
    logger.error(commonMessages.errorOccured, error);
    return res
      .status(500)
      .json(new responseModel(false, commonMessages.errorOccured));
  }
};

const handleSubscriptionPayment = async (
  orderId,
  paymentDetails,
  paymentState,
  payload,
  res,
) => {
  const subscription = await getDetailsById(subscriptionContainer, orderId);
  if (!subscription) {
    return res
      .status(404)
      .json(new responseModel(false, subscriptionMessages.notfound));
  }

  // Add payment record
  if (!Array.isArray(subscription.payments)) {
    subscription.payments = [];
  }

  subscription.payments.push({
    paymentDetails,
    paymentStatus: paymentState,
    paidAmount: subscription.totalPrice,
    paidOn: new Date().toISOString(),
  });

  if (paymentState === "COMPLETED") {
    await createSubscriptionOrders(subscription, paymentDetails);
    await clearUserCart(subscription.phone);
    subscription.subscriptionOrderDates = [
      ...(subscription.subscriptionOrderDates || []),
      ...subscription.pendingOrderDates,
    ];
    subscription.pendingOrderDates = [];
  }

  await subscriptionContainer
    .item(subscription.id, subscription.id)
    .replace(subscription);

  return res
    .status(200)
    .json(new responseModel(true, `Payment ${paymentState}`, payload));
};

const createSubscriptionOrders = async (subscription, paymentDetails) => {
  for (const deliveryDate of subscription.pendingOrderDates) {
    const scheduledDelivery = dayjs(
      `${deliveryDate}T${subscription.deliveryTime}Z`,
    );
    const newOrderId = await getNextOrderId();
    const order = {
      id: `S${newOrderId}`,
      customerDetails: subscription.customerDetails,
      productDetails: subscription.products,
      storeDetails: subscription.storeDetails,
      subscriptionId: subscription.id,
      scheduledDelivery: scheduledDelivery,
      status: "New",
      priceDetails: parseFloat(subscription.priceDetails),
      orderType: orderCategoriesMap.subscriptions,
      storeAdminId: subscription.storeAdminId || "",
      PaymentDetails: {
        paymentStatus: "COMPLETED",
        paymentDetails,
      },
      createdOn: convertUTCtoIST(new Date().toISOString()),
    };

    await createOrder(order);
    await updateProductQuantities(order);
  }
};
const handleNormalOrderPayment = async (
  orderId,
  paymentDetails,
  paymentState,
  payload,
  res,
) => {
  const order = await findOrder(orderId);

  order.PaymentDetails = {
    paymentStatus: paymentState,
    paymentDetails,
  };

  if (paymentState === "COMPLETED") {
    await updateProductQuantities(order);
  }

  var options = {
      method: "POST",
      url: process.env.msg91Url,
      headers: {
        accept: "application/json",
        authkey: process.env.msg91AuthKey,
        "content-type": "application/json",
      },

      data: msg91Templates.orderSMS
        .replace("{templateId}", msg91TemplateIds.orderTemplateId)
        .replace("{phone}", order.customerDetails.phone)
        .replace("{orderId}", orderId)
        .replace("{paymentStatus}", paymentState)
        .replace("{amount}", paymentDetails.amount)
        .replace(
          "{deliveryDate}",
          dayjs(order.scheduledDelivery).format("DD-MM-YYYY HH:mmA"),
        ),
    };

    await axios.request(options);

  await orderContainer.item(order.id, order.id).replace(order);

  const customerDetails = await getDetailsById(
    customerContainer,
    order.customerDetails.customerId,
  );
  await clearUserCart(customerDetails.phone);

  return res
    .status(200)
    .json(new responseModel(true, `Payment ${paymentState}`, payload));
};
const clearUserCart = async (phone) => {
  const cartItems = await getUserDetails(cartItemContainer, phone);
  if (cartItems && cartItems.products) {
    cartItems.products = [];
    await cartItemContainer.item(cartItems.id, cartItems.id).replace(cartItems);
  }
};

const updateProductQuantities = async (order) => {
  try {
    const { storeDetails, productDetails } = order;
    const querySpec = {
      query: "SELECT * FROM c WHERE c.storeId = @storeId",
      parameters: [{ name: "@storeId", value: storeDetails.id }],
    };

    const { resources } = await storeProductContainer.items
      .query(querySpec)
      .fetchAll();

    if (!resources.length) return;

    const storeDoc = resources[0];
    let updated = false;
    for (const item of productDetails) {
      const { productId, variantId, quantity } = item;
      if (!productId || !quantity) continue;

      const product = storeDoc.products.find((p) => p.productId === productId);
      if (!product) continue;

      if (variantId) {
        const variant = product.variants?.find(
          (v) => v.variantId === variantId,
        );
        if (variant) {
          if (variant.stock >= quantity) {
            variant.stock -= quantity;
            product.stock = product.variants.reduce(
              (sum, v) => sum + v.stock,
              0,
            );

            updated = true;
          } else {
            logger.error(`${orderMessages.outofstock} ${variantId}`);
          }
        }
      } else {
        if (product.stock >= quantity) {
          product.stock -= quantity;
          updated = true;
        } else {
          logger.error(`${orderMessages.outofstock} ${productId}`);
        }
      }
    }

    if (updated) {
      await storeProductContainer
        .item(storeDoc.id, storeDoc.id)
        .replace(storeDoc);
    }
  } catch (error) {
    logger.error(commonMessages.errorOccured, error);
  }
};

const refundProcess = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await findOrder(orderId);
    if (!order)
      return res
        .status(404)
        .json(new responseModel(false, orderMessages.orderNotfound));
    if (req.user.id !== order.storeAdminId)
      return res
        .status(403)
        .json(new responseModel(false, authMessage.unauthorizedAccess));
    if (order.PaymentDetails.paymentStatus !== "COMPLETED")
      return res
        .status(400)
        .json(new responseModel(false, paymentMessages.paymentPending));

    const paymentDetails = order.PaymentDetails.paymentDetails[0];

    const originalMerchantOrderId =
      paymentDetails?.transactionId || order.merchantOrderId || order.id;

    if (!originalMerchantOrderId) {
      return res
        .status(400)
        .json(new responseModel(false, paymentMessages.refundFailed));
    }

    const refundAmount = Math.round(order.priceDetails.totalPrice * 100);
    if (refundAmount < 100) {
      return res
        .status(400)
        .json(
          new responseModel(
            false,
            "Refund amount below minimum allowed (100 paise)",
          ),
        );
    }

    const merchantRefundId = `refund_${Date.now()}`;
    const request = RefundRequest.builder()
      .amount(refundAmount)
      .merchantRefundId(merchantRefundId)
      .originalMerchantOrderId(originalMerchantOrderId)
      .build();

    const refundResponse = await client.refund(request);
    console.log("refundResponse:", refundResponse);

    if (!refundResponse || !refundResponse.refundId) {
      return res
        .status(500)
        .json(
          new responseModel(
            false,
            paymentMessages.refundFailed,
            refundResponse,
          ),
        );
    }

    await orderContainer.item(order.id, order.id).patch([
      {
        op: "add",
        path: "/refundDetails",
        value: {
          refundId: refundResponse.refundId,
          refundStatus: refundResponse.state,
          refundedOn: new Date().toISOString(),
        },
      },
    ]);
    return res
      .status(200)
      .json(
        new responseModel(true, paymentMessages.refundSuccess, refundResponse),
      );
  } catch (error) {
    logger.error(commonMessages.errorOccured, error);
    return res.status(500).json(new responseModel(false, error.message));
  }
};

const refundStatus = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await findOrder(orderId);
    if (!order) {
      return res
        .status(404)
        .json(new responseModel(false, subscriptionMessages.notfound));
    }
    if (req.user.id !== order.customerDetails.customerId) {
      return res
        .status(403)
        .json(new responseModel(false, authMessage.unauthorizedAccess));
    }
    if (order.PaymentDetails.paymentStatus !== "COMPLETED") {
      return res
        .status(400)
        .json(new responseModel(false, paymentMessages.paymentPending));
    }

    const response = await client.getRefundStatus(order.id);
    if (response.state === "COMPLETED") {
      return res
        .status(200)
        .json(new responseModel(true, paymentMessages.refundSuccess, response));
    } else {
      return res
        .status(200)
        .json(new responseModel(false, paymentMessages.refunding, response));
    }
  } catch (error) {
    logger.error(commonMessages.errorOccured, error);
    return res.status(500).json(new responseModel(false, error.message));
  }
};

function getContainerById(id) {
  try {
    return getContainer(id);
  } catch (error) {
    logger.error(`Unknown container ID: ${id}`, error);
    throw new Error(`Unknown container ID: ${id}`);
  }
}

module.exports = {
  createPayment,
  handlePaymentStatus,
  refundProcess,
  refundStatus,
};
