import { Hono } from 'hono';
import Stripe from 'stripe';
import { db, getUser } from './db.js';
import { authMiddleware, type AppEnv } from './auth.js';

const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const priceId = process.env.STRIPE_PRO_PRICE_ID ?? '';
const publicUrl = new URL(process.env.PUBLIC_URL ?? 'http://localhost:8787');
const stripe = stripeKey ? new Stripe(stripeKey) : null;

export const billing = new Hono<AppEnv>();

billing.use('/portal', authMiddleware);
billing.use('/checkout', authMiddleware);

billing.post('/checkout', async (c) => {
	if (!stripe || !priceId) { return c.json({ error: 'billing disabled' }, 503); }
	const userId = c.get('userId') as string;
	const user = getUser(userId);
	if (!user) { return c.json({ error: 'user not found' }, 404); }
	let customerId = user.stripe_customer_id;
	if (!customerId) {
		const customer = await stripe.customers.create({ email: user.email ?? undefined, metadata: { user_id: user.id } });
		customerId = customer.id;
		db.prepare(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`).run(customerId, user.id);
	}
	const session = await stripe.checkout.sessions.create({
		mode: 'subscription',
		customer: customerId,
		line_items: [{ price: priceId, quantity: 1 }],
		success_url: new URL('/billing/success', publicUrl).toString(),
		cancel_url: new URL('/billing/cancel', publicUrl).toString(),
	});
	return c.json({ url: session.url });
});

billing.post('/webhook', async (c) => {
	if (!stripe || !webhookSecret) { return c.text('disabled', 503); }
	const sig = c.req.header('stripe-signature') ?? '';
	const raw = await c.req.text();
	let event: Stripe.Event;
	try {
		event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
	} catch {
		return c.text('invalid webhook signature', 400);
	}
	if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
		const obj: any = event.data.object;
		const customerId = obj.customer;
		const status = obj.status === 'active' || obj.payment_status === 'paid' ? 'pro' : 'free';
		db.prepare(`UPDATE users SET plan = ? WHERE stripe_customer_id = ?`).run(status, customerId);
	} else if (event.type === 'customer.subscription.deleted') {
		const obj: any = event.data.object;
		db.prepare(`UPDATE users SET plan = 'free' WHERE stripe_customer_id = ?`).run(obj.customer);
	}
	return c.text('ok');
});
