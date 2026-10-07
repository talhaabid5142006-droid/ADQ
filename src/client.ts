import { Client, APIGatewayBotInfo, WebhooksAPI } from '@discordjs/core';
import { RequestInit } from 'undici';
import { REST, DefaultRestOptions, ResponseLike } from '@discordjs/rest';
import { WebSocketManager, WebSocketShard } from '@discordjs/ws';
import {
	GatewaySendPayload,
	GatewayOpcodes,
} from 'discord-api-types/v10';
import { QuestManager } from './questManager';
import { AllQuestsResponse } from './interface';
import { Constants } from './constants';
import { Utils } from './utils';

async function makeRequest(
	url: string,
	init: RequestInit,
): Promise<ResponseLike> {
	if (init.headers) {
		init.headers = Utils.makeHeaders(init.headers as any);
	}
	return DefaultRestOptions.makeRequest(url, init);
}

/**
 * Patch the shard's send() so the Identify payload matches what Discord
 * expects from a real user (selfbot) client:
 *
 *   1. Replace `properties` with a full desktop-client fingerprint.
 *   2. Set `capabilities` and `client_state` to desktop-client defaults.
 *   3. DELETE the `intents` field entirely. User tokens must NOT send
 *      `intents`; Discord closes the socket with 4013 (InvalidIntents)
 *      if the field is present, even if the bitfield is "valid".
 *
 * Without step 3 the first Identify is rejected and @discordjs/ws
 * auto-reconnects (via RESUME, which doesn't revalidate) — which is why
 * the bot eventually logs in but always prints the error once.
 */
const originalSend = WebSocketShard.prototype.send;
WebSocketShard.prototype.send = async function (
	this: WebSocketShard,
	payload: GatewaySendPayload,
) {
	if (payload.op === GatewayOpcodes.Identify) {
		const d = payload.d as any;

		d.properties = {
			...Constants.Properties,
			is_fast_connect: false,
			gateway_connect_reasons: 'AppSkeleton',
		};
		d.capabilities = 0;
		d.client_state = {
			guild_versions: {},
		};

		// ⬇️ THE FIX: remove `intents` for user-token Identify payloads.
		delete d.intents;
	}
	return originalSend.call(this, payload);
};

export class ClientQuest extends Client {
	public questManager: QuestManager | null = null;
	public websocketManager: WebSocketManager;
	public webhook = new WebhooksAPI(new REST());
	#webhookId: string | null = null;
	#webhookToken: string | null = null;

	constructor(token: string) {
		if (!token) {
			throw new Error('Token is required to initialize the client.');
		}

		const rest = new REST({ version: '10', makeRequest }).setToken(token);
		rest.on('rateLimited', (info: any) => {
			console.warn(
				`\n[RateLimit]\n` +
					`  -> Route: ${info.method} ${info.route}\n` +
					`  -> Scope: ${info.scope}${info.global ? ' (Global)' : ''}\n` +
					`  -> Limit: ${info.limit} requests\n` +
					`  -> Retry after: ${info.retryAfter}ms (${(info.retryAfter / 1000).toFixed(2)}s)\n`,
			);
		});

		const gateway = new WebSocketManager({
			token,
			// Keep 0 here so @discordjs/ws doesn't inject a default bitfield
			// into the Identify payload. The send() patch above deletes the
			// field anyway, but this keeps the initial object clean.
			intents: 0,
			rest,
			readyTimeout: 120_000,
		});

		gateway.fetchGatewayInformation = (): Promise<APIGatewayBotInfo> => {
			return Promise.resolve({
				url: 'wss://gateway.discord.gg',
				shards: 1,
				session_start_limit: {
					total: 1000,
					remaining: 1000,
					reset_after: 14400000,
					max_concurrency: 1,
				},
			});
		};

		super({ rest, gateway });
		this.websocketManager = gateway;
		gateway.on('error', () => null);
	}

	connect() {
		return Promise.allSettled([
			Utils.updateLatestBuildVersion(),
			this.setupWebhook(),
		])
			.then(() => this.websocketManager.connect())
			.catch((e) => {
				console.error('Error during client connection:', e.message);
				return this.sendWebhookMessage(
					'Error during client connection: ' + e.message,
				);
			});
	}

	destroy() {
		return this.websocketManager.destroy();
	}

	setupWebhook() {
		return Utils.extractWebhookInfo().then((info) => {
			if (info) {
				this.#webhookId = info.id;
				this.#webhookToken = info.token;
				console.log('Webhook setup complete.');
			}
		});
	}

	fetchQuests(fetchExcludedQuests = false) {
		return this.rest
			.get('/quests/@me')
			.then((response) =>
				QuestManager.fromResponse(
					this,
					response as AllQuestsResponse,
					fetchExcludedQuests,
				),
			)
			.then((manager) => {
				this.questManager = manager;
				return manager;
			});
	}

	sendWebhookMessage(content: string) {
		if (this.#webhookId && this.#webhookToken) {
			this.webhook
				.execute(this.#webhookId, this.#webhookToken, {
					content,
				})
				.catch(() => {});
		}
	}

	emitQuestCompleted(questId: string) {
		return this.sendWebhookMessage(
			`[Quest Completed!](https://discord.com/quests/${questId})`,
		);
	}
}
