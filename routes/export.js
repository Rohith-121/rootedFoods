const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit-table");
const { getContainer } = require("../services/cosmosService");
const responseModel = require("../models/ResponseModel");
const { ContainerIds, orderTypesMap } = require("../constants");
const orderContainer = getContainer(ContainerIds.Order);

router.get(
  "/download-pdf-for-orders/:orderType/:orderStatus/:date",
  async (req, res) => {
    try {
      const { orderType, orderStatus, date } = req.params;

      const orderStatuses = orderTypesMap[orderStatus.toLowerCase()] || [];

      const querySpec = {
        query: `
        SELECT 
          c.id, 
          c.customerDetails, 
          c.productDetails, 
          c.storeDetails,  
          c.scheduledDelivery, 
          c.orderType, 
          c.priceDetails, 
          c.status,
          c.PaymentDetails,
          c.createdOn
        FROM c
        WHERE    
        ((
            IS_DEFINED(c.scheduledDelivery) 
            AND c.scheduledDelivery != "" 
            AND STARTSWITH(c.scheduledDelivery, @date)
        )
        OR
        (
            (c.scheduledDelivery = "")
            AND STARTSWITH(c.createdOn, @date)
        ))
        AND (@orderType != "" AND c.orderType = @orderType)
        AND ARRAY_CONTAINS(@orderStatuses, c.status)
       `,
        parameters: [
          { name: "@orderType", value: orderType },
          { name: "@date", value: date },
          { name: "@orderStatuses", value: orderStatuses },
        ],
      };

      const { resources } = await orderContainer.items
        .query(querySpec)
        .fetchAll();

      if (!resources || resources.length === 0)
        return res
          .status(200)
          .json(
            new responseModel(false, "No orders found for the given filters."),
          );

      // Create PDF doc
      const doc = new PDFDocument({
        margins: { top: 30, left: 30, right: 30, bottom: 30 },
        size: "A4",
        layout: "landscape",
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=Orders.pdf");

      doc.pipe(res);

      // Title
      doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("Orders Report", { align: "center" });

      doc.moveDown(1);

      // Prepare table rows
      const rows = resources.map((order) => {
        const {
          id,
          customerDetails,
          storeDetails,
          productDetails,
          orderType,
          scheduledDelivery,
          status,
          priceDetails,
          PaymentDetails,
          createdOn,
        } = order;

        // Delivery Time
        const deliveryTime =
          scheduledDelivery != ""
            ? new Date(scheduledDelivery)
                .toLocaleString("en-IN", { hour12: true })
                .replace(",", "")
                .replace(/\//g, "-")
            : new Date(new Date(createdOn).getTime() + 90 * 60000)
                .toLocaleString("en-IN", { hour12: true })
                .replace(",", "")
                .replace(/\//g, "-");

        // Customer
        const customerText =
          `Name: ${customerDetails.Name}\n` + `Phone: ${customerDetails.phone}`;

        // Address
        const addressText = Object.entries(customerDetails.address || {})
          .filter(([key, value]) => key !== "id" && value)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

        // Store
        const keyMap = {
          storeName: "Name",
          phone: "Phone",
          address: "Address",
        };
        const storeText = Object.entries(storeDetails || {})
          .filter(([key, value]) => key !== "id" && value)
          .map(([key, value]) => `${keyMap[key] || key}: ${value}`)
          .join("\n");

        // Products
        const productText = productDetails
          .map((p, i) => {
            const finalPrice =
              p.offerPrice && p.offerPrice > 0 ? p.offerPrice : p.price;
            return (
              `Product ${i + 1}:\n` +
              `Product Name: ${p.productName}  (${p.variantName}),\n` +
              `Quantity: ${p.quantity},\n` +
              `${p.type}: ${p.value} ${p.metrics},\n` +
              `Price: Rs. ${finalPrice}`
            );
          })
          .join("\n\n");

        // Payment
        const paymentDetails = PaymentDetails.paymentDetails?.[0];
        const paymentText = paymentDetails
          ? `Status: ${PaymentDetails.paymentStatus}\n` +
            `Paid On: ${new Date(PaymentDetails.paidOn).toLocaleString("en-IN", { hour12: true })}\n` +
            `Mode: ${paymentDetails.paymentMode}\n` +
            `Txn: ${paymentDetails.transactionId}\n` +
            `Amount: Rs. ${paymentDetails.amount}`
          : `Status: ${PaymentDetails.paymentStatus || "Pending"}\nNo payment details.`;

        // Order details
        const orderDetails =
          `Order ID: ${id}\n` +
          `Type: ${orderType}\n` +
          `Status: ${status}\n` +
          `Delivery: ${deliveryTime}\n` +
          `Total: Rs. ${priceDetails.totalPrice}`;

        return [
          orderDetails,
          storeText,
          productText,
          customerText,
          addressText,
          paymentText,
        ];
      });

      doc
        .font("Helvetica-Bold") // make bold
        .fontSize(16) // bigger text
        .text(
          `Order Type: ${orderType}, Order Status: ${orderStatus}, Date: ${date.split("-").reverse().join("-")}`,
          { align: "center" }, // center align
        );

      doc.moveDown(1);

      // Build table
      const table = {
        headers: [
          { label: "Order Details", property: "orderDetails" },
          { label: "Store Details", property: "store" },
          { label: "Products List", property: "products" },
          { label: "Customer Details", property: "customer" },
          { label: "Delivery Address", property: "address" },
          { label: "Payment Details", property: "payment" },
        ],
        rows,
      };

      await doc.table(table, {
        prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10),
        prepareRow: () => doc.font("Helvetica").fontSize(9),
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        divider: {
          header: { disabled: false, width: 1, color: "#000000" }, // header bottom line
          horizontal: { width: 1, color: "#000000" }, // between rows
          vertical: { width: 1, color: "#000000" }, // between columns
        },
      });

      doc.end();
    } catch (err) {
      console.error(err);
      return res
        .status(500)
        .json(new responseModel(false, "Error while generating PDF"));
    }
  },
);

module.exports = router;
