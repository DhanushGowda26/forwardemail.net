const Stripe = require('stripe');

const env = require('#config/env');
const { Payments } = require('#models');
const { paypalAgent } = require('#helpers/paypal');

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

// this function accepts a payment ID
// and refunds it appropriately in Stripe or PayPal
async function refund(id) {
  const payment = await Payments.findById(id);
  if (!payment) throw new Error('Payment does not exist');
  //
  // if it was stripe then we can attempt to refund by:
  // - stripe_payment_intent_id
  //
  if (payment.stripe_payment_intent_id) {
    await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id
    });
    payment.amount_refunded = payment.amount;
    await payment.save();
    return payment.toObject();
  }

  //
  // if it was paypal then we can attempt to refund by:
  // - paypal_transaction_id
  //
  if (payment.paypal_transaction_id) {
    const agent = await paypalAgent();
    // <https://developer.paypal.com/docs/api/payments/v2/#captures_refund>
    await agent.post(
      `/v2/payments/captures/${payment.paypal_transaction_id}/refund`
    );
    payment.amount_refunded = payment.amount;
    await payment.save();
    return payment.toObject();
  }

  // otherwise throw an error
  throw new Error(
    'Unknown payment to refund; no Stripe or PayPal necessary ID'
  );
}

module.exports = refund;
