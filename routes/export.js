const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit-table");
const { getContainer } = require("../services/cosmosService");
const { ContainerIds } = require("../constants");

const orderContainer = getContainer(ContainerIds.Order);

router.get(
  "/download-pdf-for-orders/:orderType/:orderStatus/:date",
  async (req, res) => {
    try {
      const { orderType, orderStatus, date } = req.params;

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
        AND (@orderStatus != "" AND c.status = @orderStatus)
       `,
        parameters: [
          { name: "@orderType", value: orderType },
          { name: "@date", value: date },
          { name: "@orderStatus", value: orderStatus },
        ],
      };

      const { resources } = await orderContainer.items
        .query(querySpec)
        .fetchAll();

      // Create PDF doc
      const doc = new PDFDocument({ margin: 30, size: "A4" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=Orders.pdf");

      doc.pipe(res);

      // Title
      doc
        .fontSize(18)
        .fillColor("#333")
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
        const customerText = `Name: ${customerDetails.Name}\nPhone: ${customerDetails.phone}`;

        // Address
        const addressText = Object.entries(customerDetails.address || {})
          .filter(([, value]) => value)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

        // Store
        const keyMap = { storeName: "Name", phone: "Phone" };
        const storeText = Object.entries(storeDetails || {})
          .filter(([key, value]) => key !== "id" && value)
          .map(([key, value]) => `${keyMap[key] || key}: ${value}`)
          .join("\n");

        // Products
        const productText = productDetails
          .map((p, i) => {
            const finalPrice =
              p.offerPrice && p.offerPrice > 0 ? p.offerPrice : p.price;
            return `Product ${i + 1}:
            ${p.productName} (${p.variantName})
            Qty: ${p.quantity}, ${p.type}: ${p.value} ${p.metrics}
            Price: ₹${finalPrice}`;
          })
          .join("\n\n");

        // Payment
        const paymentDetails = PaymentDetails.paymentDetails?.[0];
        const paymentText = paymentDetails
          ? `Status: ${PaymentDetails.paymentStatus}
          Paid On: ${new Date(PaymentDetails.paidOn).toLocaleString("en-IN", { hour12: true })}
          Mode: ${paymentDetails.paymentMode}
          Txn: ${paymentDetails.transactionId}
          Amount: ₹${paymentDetails.amount}
          State: ${paymentDetails.state}`
          : `Status: ${PaymentDetails.paymentStatus || "Pending"}\nNo payment details.`;

        // Order details
        const orderDetails = `Order ID: ${id}
        Type: ${orderType}
        Status: ${status}
        Delivery: ${deliveryTime}
        Total: ₹${priceDetails.totalPrice}`;

        return [
          orderDetails,
          customerText,
          addressText,
          storeText,
          productText,
          paymentText,
        ];
      });

      // Build table
      const table = {
        title: "Orders",
        headers: [
          { label: "Order Details", property: "orderDetails", width: 90 },
          { label: "Customer Details", property: "customer", width: 80 },
          { label: "Address", property: "address", width: 100 },
          { label: "Store", property: "store", width: 80 },
          { label: "Products", property: "products", width: 110 },
          { label: "Payment", property: "payment", width: 90 },
        ],
        rows,
      };

      await doc.table(table, {
        prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10),
        prepareRow: () => doc.font("Helvetica").fontSize(9),
        padding: 5,
        columnSpacing: 5,
        width: 500,
        divider: {
          header: { disabled: false, width: 1, color: "#000000" }, // header bottom line
          horizontal: { width: 1, color: "#000000" }, // between rows
          vertical: { width: 1, color: "#000000" }, // between columns
        },
        options: {
          border: {
            top: true,
            bottom: true,
            left: true,
            right: true,
            width: 1,
            color: "#000000",
          },
          // Some versions require 'options.border' instead of 'border' directly
        },
      });

      doc.end();
    } catch (err) {
      console.error(err);
      return res.status(500).send("Error while generating PDF");
    }
  },
);

module.exports = router;
