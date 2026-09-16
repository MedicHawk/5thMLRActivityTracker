import 'dotenv/config';
import { register } from './commands.js';
const token=process.env.DISCORD_TOKEN,client=process.env.DISCORD_CLIENT_ID;
if(!token||!client)throw new Error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID');
await register(token,client,process.env.DISCORD_GUILD_ID);
console.log('Slash commands registered');
