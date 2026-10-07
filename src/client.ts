import { GatewayDispatchEvents } from 'discord-api-types/v10';
import { ClientQuest } from './src/client';
import { Utils } from './src/utils';
import { Constants } from './src/constants';

let currentUserId: string | null = null;

async function main() {
	// 1. Fetch the latest build FIRST, so Constants.Properties is accurate
	//    before the WebSocket shard's Identify payload is created.
	const build = await Utils.updateLatestBuildVersion();
	Constants.updateBuild(build);
	console.log(`Build number: ${build}`);

	// 2. Now safe to construct the client with synced properties.
	const client = new ClientQuest(process.env.TOKEN!);

	client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
		currentUserId = data.user.id;
		if (process.env.GITHUB_ACTIONS === 'true') {
			console.log('Logged in!');
		} else {
			console.log(`Logged in as @${data.user.username}`);
		}

		await client.fetchQuests(false);
		const questsValid = client.questManager!.filterQuestsValidToDo();
		console.log(`Found ${questsValid.length} valid quests to do.`);
		await Promise.allSettled(
			questsValid.map((quest) => client.questManager!.doingQuest(quest)),
		);

		console.log('All quests processed. Disconnecting...');
		await client.destroy();
	});

	await client.connect();
}

process.on('unhandledRejection', () => {
	console.error('[Error:] Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
	console.error('Uncaught Exception:', error.message);
});

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
