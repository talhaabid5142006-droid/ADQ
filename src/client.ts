import { Client, APIGatewayBotInfo, WebhooksAPI } from '@discordjs/core';
import { RequestInit } from 'undici';
import { REST, DefaultRestOptions, ResponseLike } from '@discordjs/rest';
import { WebSocketManager, WebSocketShard } from '@discordjs/ws';
import {
	GatewaySendPayload,
	GatewayOpcodes,
	GatewayIntentBits,
} from 'discord-api-types/v10';
import { QuestManager } from './questManager';
import { AllQuestsResponse } from './interface';
import { Constants } from './constants';
import { Utils } from './utils';

/** User-account intents = 105512949 */
const USER_INTENTS =
	GatewayIntentBits.Guilds |
	GatewayIntentBits.GuildMembers |
	GatewayIntentBits.GuildPresences |
	GatewayIntentBits.GuildMessages |
	GatewayIntentBits.GuildMessageReactions |
	GatewayIntentBits.DirectMessages |
	GatewayIntentBits.DirectMessageReactions |
	GatewayIntentBits.GuildVoiceStates;

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
 * Patch the shard's Identify payload at construction time, so the *first*
 * handshake is a valid user-client Identify. Without this, @discordjs/ws
 * sends a bot-style Identify and Discord closes with `Used invalid intents`;
 * the library then auto-reconnects (via resume) which is why it eventually
 * logs in — but the first attempt always errors.
 */
const OriginalWebSocketShard = WebSocketShard as any;
const originalShardSend = WebSocketShard.prototype.send;

WebSocketShard.prototype.send = async function (
	this: WebSocketShard,
	payload: GatewaySendPayload,
) {
	if (payload.op === GatewayOpcodes.Identify) {
		payload.d = {
			...payload.d,
			properties: {
				...Constants.Properties,
				is_fast_connect: false,
				gateway_connect_reasons: 'AppSkeleton',
			},
			capabilities: 0,
			client_state: {
				guild_versions: {},
			},
		} as any;
	}
	return originalShardSend.call(this, payload);
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
			intents: USER_INTENTS,
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
				.execute(this.#webhookId, this.#webhookToken, { content })
				.catch(() => {});
		}
	}

	emitQuestCompleted(questId: string) {
		return this.sendWebhookMessage(
			`[Quest Completed!](https://discord.com/quests/${questId})`,
		);
	}
}
