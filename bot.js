const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const readline = require('readline');

class MinecraftBotSpawner {
    constructor() {
        this.bots = [];
        this.followMode = false;
        this.attackMode = false;
        this.protectMode = false;
        this.attackTarget = null;
        this.masterPlayer = null;
        this.ownerUsername = null;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        this.retryAttempts = 5;
        this.retryDelay = 10000;
        this.attackedPlayers = new Set();
    }

    async getUserInput() {
        const serverAddress = await this.question('Nhập địa chỉ server (VD: localhost hoặc play.hypixel.net): ');
        const port = await this.question('Nhập port (mặc định 25565, nhấn Enter để bỏ qua): ') || 25565;
        const botCount = parseInt(await this.question('Nhập số lượng bot: '));
        const botNamePrefix = await this.question('Nhập tên prefix cho bot (VD: Bot_): ');
        const version = await this.question('Nhập version Minecraft (VD: 1.20.1, nhấn Enter cho mặc định): ') || '1.20.1';
        const ownerName = await this.question('Nhập username OWNER (chỉ owner mới điều khiển được bot): ');
        const masterName = await this.question('Nhập tên player chính để bot follow (có thể giống owner): ') || ownerName;

        return {
            host: serverAddress,
            port: parseInt(port),
            botCount,
            botNamePrefix,
            version,
            ownerName,
            masterName
        };
    }

    question(prompt) {
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    async createBot(config, botIndex, attempt = 1) {
        const botName = `${config.botNamePrefix}${botIndex}`;
        
        console.log(`🤖 [Lần thử ${attempt}] Đang tạo bot: ${botName}`);

        try {
            const bot = mineflayer.createBot({
                host: config.host,
                port: config.port,
                username: botName,
                version: config.version,
                auth: 'offline',
                hideErrors: false,
                checkTimeoutInterval: 120000,
                keepAlive: true
            });

            try {
                bot.loadPlugin(pathfinder);
                console.log(`✅ Đã load pathfinder cho ${botName}`);
            } catch (e) {
                console.log(`⚠️ Không load được pathfinder cho ${botName}: ${e.message}`);
            }

            const connectionPromise = new Promise((resolve, reject) => {
                bot.once('login', () => {
                    console.log(`✅ Bot ${botName} đã login thành công!`);
                    this.equipBestArmor(bot);
                    this.equipBestWeapon(bot);
                    resolve(bot);
                });

                bot.on('error', (err) => {
                    if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
                        console.log(`❌ Bot ${botName} gặp lỗi ${err.code}, thử reconnect...`);
                        reject(err);
                    } else {
                        console.log(`❌ Bot ${botName} gặp lỗi: ${err.message}`);
                        reject(err);
                    }
                });

                bot.once('kicked', (reason) => {
                    console.log(`👢 Bot ${botName} bị kick: ${reason}`);
                    reject(new Error(`Bot bị kick: ${reason}`));
                });
            });

            const botInstance = await connectionPromise;
            this.setupBotHandlers(botInstance, botName, config);
            this.setupCustomPvP(botInstance, botName);
            this.setupProtectionSystem(botInstance, botName, config);
            
            setInterval(() => {
                if (!botInstance.entity) {
                    console.log(`🔧 Bot ${botName} mất kết nối, thử reconnect...`);
                    this.reconnectBot(config, botIndex);
                }
            }, 30000);

            return botInstance;

        } catch (error) {
            console.log(`❌ Bot ${botName} lỗi lần thử ${attempt}: ${error.message}`);
            
            if (attempt < this.retryAttempts) {
                console.log(`🔄 Thử lại sau ${this.retryDelay/1000} giây...`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                return this.createBot(config, botIndex, attempt + 1);
            } else {
                console.log(`💀 Bot ${botName} không thể kết nối sau ${this.retryAttempts} lần thử`);
                throw error;
            }
        }
    }

    setupBotHandlers(bot, botName, config) {
        bot.on('chat', (username, message) => {
            if (username === bot.username || username !== config.ownerName) return;
            console.log(`💬 [${botName}] ${username}: ${message}`);
            this.handleChatCommands(username, message, config);
        });

        bot.on('error', (err) => {
            console.log(`❌ Bot ${botName} gặp lỗi: ${err.message}`);
        });

        bot.on('kicked', (reason) => {
            console.log(`👢 Bot ${botName} bị kick: ${reason}`);
            setTimeout(() => {
                this.reconnectBot(config, this.bots.indexOf(bot) + 1);
            }, 10000);
        });

        bot.on('end', () => {
            console.log(`🔌 Bot ${botName} đã ngắt kết nối`);
            setTimeout(() => {
                this.reconnectBot(config, this.bots.indexOf(bot) + 1).then(() => {
                    this.startCommandPanel(config); // Quay lại menu sau reconnect
                });
            }, 5000);
        });

        this.addBasicFeatures(bot, botName, config);
    }

    setupCustomPvP(bot, botName) {
        bot.customPvP = {
            attack: (targetEntity) => {
                if (!targetEntity || !bot.entity) return;

                const distance = bot.entity.position.distanceTo(targetEntity.position);
                if (distance > 4.5) {
                    this.followTarget(bot, targetEntity);
                } else {
                    bot.lookAt(targetEntity.position.offset(0, targetEntity.height * (distance < 1.5 ? 0.3 : 0.8), 0)); // Leg Hit khi gần

                    let attackCount = 0;
                    const attackState = {
                        mode: 'w-tap', // w-tap, s-tap, block-hit, strafe
                        lastHit: Date.now(),
                        strafeDirection: 1
                    };

                    const attackInterval = setInterval(() => {
                        if (!targetEntity || !bot.entity) {
                            clearInterval(attackInterval);
                            return;
                        }

                        const now = Date.now();
                        if (attackCount >= 6 || distance > 4.5) {
                            clearInterval(attackInterval);
                            return;
                        }

                        if (now - attackState.lastHit < 400) return; // Giới hạn tốc độ hit

                        switch (attackState.mode) {
                            case 'w-tap':
                                if (distance >= 3 && distance <= 4.5) {
                                    bot.setControlState('sprint', true);
                                    bot.setControlState('forward', true);
                                    setTimeout(() => {
                                        bot.attack(targetEntity);
                                        attackCount++;
                                        attackState.lastHit = now;
                                        console.log(`⚔️ ${botName} W-Tap hit ${attackCount} trên ${targetEntity.displayName || 'target'}`);
                                        bot.setControlState('back', true);
                                        setTimeout(() => {
                                            bot.setControlState('back', false);
                                            bot.setControlState('sprint', false);
                                            attackState.mode = 's-tap'; // Chuyển sang S-Tap
                                        }, 200);
                                    }, 100);
                                    bot.setControlState('forward', false);
                                }
                                break;

                            case 's-tap':
                                if (distance < 3) {
                                    bot.setControlState('back', true);
                                    setTimeout(() => {
                                        bot.attack(targetEntity);
                                        attackCount++;
                                        attackState.lastHit = now;
                                        console.log(`⚔️ ${botName} S-Tap hit ${attackCount} trên ${targetEntity.displayName || 'target'}`);
                                        bot.setControlState('forward', true);
                                        setTimeout(() => {
                                            bot.setControlState('forward', false);
                                            bot.setControlState('sprint', false);
                                            attackState.mode = 'block-hit'; // Chuyển sang Block Hit
                                        }, 200);
                                    }, 100);
                                }
                                break;

                            case 'block-hit':
                                if (distance <= 3.5) {
                                    bot.setControlState('jump', true); // Né đòn
                                    setTimeout(() => {
                                        bot.attack(targetEntity);
                                        attackCount++;
                                        attackState.lastHit = now;
                                        console.log(`⚔️ ${botName} Block-Hit hit ${attackCount} trên ${targetEntity.displayName || 'target'}`);
                                        bot.setControlState('jump', false);
                                        attackState.mode = 'strafe'; // Chuyển sang Strafe
                                    }, 150);
                                }
                                break;

                            case 'strafe':
                                if (distance <= 4) {
                                    bot.setControlState(attackState.strafeDirection === 1 ? 'left' : 'right', true);
                                    bot.setControlState('sprint', true);
                                    setTimeout(() => {
                                        bot.attack(targetEntity);
                                        attackCount++;
                                        attackState.lastHit = now;
                                        console.log(`⚔️ ${botName} Strafe-Hit hit ${attackCount} trên ${targetEntity.displayName || 'target'}`);
                                        bot.setControlState(attackState.strafeDirection === 1 ? 'left' : 'right', false);
                                        attackState.strafeDirection *= -1; // Đổi hướng
                                        if (attackCount % 2 === 0) attackState.mode = 'leg-hit'; // Chuyển sang Leg Hit
                                    }, 100);
                                }
                                break;

                            case 'leg-hit':
                                if (distance <= 2) {
                                    bot.lookAt(targetEntity.position.offset(0, 0.3, 0)); // Hit thấp
                                    bot.attack(targetEntity);
                                    attackCount++;
                                    attackState.lastHit = now;
                                    console.log(`⚔️ ${botName} Leg-Hit hit ${attackCount} trên ${targetEntity.displayName || 'target'}`);
                                    attackState.mode = 'w-tap'; // Quay lại W-Tap
                                }
                                break;
                        }
                    }, 400); // Tốc độ hit cơ bản
                }
            },
            stop: () => {
                bot.pathfinder?.setGoal(null);
                ['forward', 'back', 'left', 'right', 'jump', 'sprint'].forEach(control => bot.setControlState(control, false));
                console.log(`🛑 ${botName} dừng PvP!`);
            }
        };
    }

    setupProtectionSystem(bot, botName, config) {
        bot.on('entityHurt', (entity) => {
            if (!this.protectMode || !entity.username) return;
            
            if (entity.username === config.ownerName || entity.username === config.masterName) {
                const attacker = this.findNearestThreat(bot, entity);
                if (attacker) {
                    console.log(`🛡️ PROTECT MODE: ${entity.username} bị tấn công bởi ${attacker.username || attacker.displayName || 'Unknown'}!`);
                    if (attacker.username) this.attackedPlayers.add(attacker.username);
                    this.protectOwner(attacker.username || attacker.displayName);
                    this.followMode = false; // Tạm dừng follow
                }
            }
        });

        bot.on('physicsTick', () => {
            if (!this.protectMode) return;
            
            const owner = bot.players[config.ownerName] || bot.players[config.masterName];
            if (!owner || !owner.entity) return;

            const threats = this.findThreatsNearOwner(bot, owner.entity, 10); // Bán kính lớn hơn
            if (threats.length > 0) {
                const threat = threats[0]; // Tấn công mối đe dọa gần nhất
                bot.chat(`🛡️ PROTECTING OWNER from ${threat.username || threat.displayName}!`);
                bot.customPvP.attack(threat);
                this.followMode = false; // Ưu tiên protect
            } else {
                this.followMode = true; // Khi an toàn, quay lại follow
                this.followTarget(bot, owner.entity);
            }
        });
    }

    findNearestThreat(bot, victimEntity) {
        let nearestThreat = null;
        let minDistance = Infinity;

        Object.values(bot.players).forEach(player => {
            if (player.entity && player.username !== bot.username && player.username !== this.ownerUsername) {
                const distance = player.entity.position.distanceTo(victimEntity.position);
                if (distance < 10 && distance < minDistance) {
                    minDistance = distance;
                    nearestThreat = player.entity;
                }
            }
        });

        Object.values(bot.entities).forEach(entity => {
            if (this.isHostileMob(entity)) {
                const distance = entity.position.distanceTo(victimEntity.position);
                if (distance < 10 && distance < minDistance) {
                    minDistance = distance;
                    nearestThreat = entity;
                }
            }
        });

        return nearestThreat;
    }

    findThreatsNearOwner(bot, ownerEntity, radius) {
        const threats = [];

        Object.values(bot.players).forEach(player => {
            if (player.entity && player.username !== bot.username && player.username !== this.ownerUsername) {
                const distance = player.entity.position.distanceTo(ownerEntity.position);
                if (distance <= radius) {
                    threats.push({
                        ...player.entity,
                        type: 'player',
                        username: player.username
                    });
                }
            }
        });

        Object.values(bot.entities).forEach(entity => {
            if (this.isHostileMob(entity)) {
                const distance = entity.position.distanceTo(ownerEntity.position);
                if (distance <= radius) {
                    threats.push({
                        ...entity,
                        type: 'mob'
                    });
                }
            }
        });

        return threats.sort((a, b) => a.position.distanceTo(ownerEntity.position) - b.position.distanceTo(ownerEntity.position));
    }

    isHostileMob(entity) {
        if (!entity || !entity.displayName) return false;
        
        const hostileMobs = [
            'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
            'zombie_pigman', 'blaze', 'ghast', 'slime', 'magma_cube',
            'silverfish', 'cave_spider', 'wither_skeleton', 'guardian',
            'elder_guardian', 'shulker', 'phantom', 'drowned', 'husk',
            'stray', 'vex', 'vindicator', 'evoker', 'pillager', 'ravager'
        ];

        return hostileMobs.some(mob => 
            entity.displayName.toLowerCase().includes(mob) ||
            entity.name?.toLowerCase().includes(mob)
        );
    }

    protectOwner(attackerName) {
        if (!attackerName) return;
        
        console.log(`🛡️ TRANG THÁI BẢO VỆ: Tất cả bot bảo vệ owner khỏi ${attackerName}!`);
        
        this.bots.forEach(bot => {
            if (bot.chat) {
                bot.chat(`🛡️ PROTECTING OWNER FROM ${attackerName}!`);
            }
            this.startProtectiveAttack(bot, attackerName);
        });
    }

    protectFromMob(mobEntity) {
        console.log(`🛡️ TRANG THÁI BẢO VỆ: Tất cả bot bảo vệ owner khỏi ${mobEntity.displayName}!`);
        
        this.bots.forEach(bot => {
            if (bot.chat) {
                bot.chat(`🛡️ PROTECTING FROM ${mobEntity.displayName}!`);
            }
            this.startMobProtection(bot, mobEntity);
        });
    }

    startProtectiveAttack(bot, targetPlayerName) {
        const targetEntity = bot.players[targetPlayerName]?.entity;
        if (!targetEntity) return;
        bot.customPvP.attack(targetEntity);
    }

    startMobProtection(bot, mobEntity) {
        bot.customPvP.attack(mobEntity);
    }

    async reconnectBot(config, botIndex) {
        const botName = `${config.botNamePrefix}${botIndex}`;
        console.log(`🔄 Đang thử kết nối lại bot ${botName}...`);
        
        try {
            const newBot = await this.createBot(config, botIndex);
            this.bots[botIndex - 1] = newBot;
            console.log(`✅ Bot ${botName} đã reconnect thành công!`);
            this.equipBestArmor(newBot);
            this.equipBestWeapon(newBot);
        } catch (error) {
            console.log(`💀 Không thể kết nối lại bot ${botName}`);
        }
        this.startCommandPanel(config); // Quay lại panel sau reconnect
    }

    handleChatCommands(username, message, config) {
        if (username !== config.ownerName) return;

        const args = message.trim().split(' ');
        const command = args[0].toLowerCase();
        console.log(`📡 Nhận lệnh ${command} từ ${username}`);

        switch (command) {
            case '!chat':
                const chatMessage = args.slice(1).join(' ');
                const repeatCount = parseInt(args[args.length - 1]) || 1;
                if (chatMessage && this.bots.some(bot => bot.player)) {
                    this.executeChat(chatMessage, repeatCount);
                    this.bots.forEach(bot => bot.chat(`✅ Chat "${chatMessage}" x${repeatCount} thành công!`));
                } else {
                    this.bots.forEach(bot => bot.chat('❌ Lỗi chat: Không có bot hoạt động!'));
                }
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!follow':
                if (args[1]?.toLowerCase() === 'on' && this.bots.some(bot => bot.player)) {
                    this.followMode = true;
                    this.masterPlayer = config.ownerName;
                    this.bots.forEach(bot => {
                        if (bot.chat) bot.chat('🤖 Follow mode ON!');
                        this.followTarget(bot, bot.players[config.ownerName]?.entity);
                    });
                    this.bots.forEach(bot => bot.chat('✅ Follow ON thành công!'));
                } else if (args[1]?.toLowerCase() === 'off') {
                    this.followMode = false;
                    this.masterPlayer = null;
                    this.bots.forEach(bot => {
                        if (bot.chat) bot.chat('🤖 Follow mode OFF!');
                        this.stopBotMovement(bot);
                    });
                    this.bots.forEach(bot => bot.chat('✅ Follow OFF thành công!'));
                }
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!protect':
                if (args[1]?.toLowerCase() === 'on' && this.bots.some(bot => bot.player)) {
                    this.protectMode = true;
                    this.attackedPlayers.clear();
                    this.bots.forEach(bot => {
                        if (bot.chat) bot.chat('🛡️ PROTECT MODE: ON! Tôi sẽ bảo vệ bạn!');
                    });
                    this.bots.forEach(bot => bot.chat('✅ Protect ON thành công!'));
                } else if (args[1]?.toLowerCase() === 'off') {
                    this.protectMode = false;
                    this.attackedPlayers.clear();
                    this.bots.forEach(bot => {
                        if (bot.chat) bot.chat('🛡️ PROTECT MODE: OFF!');
                        this.stopBotMovement(bot);
                    });
                    this.bots.forEach(bot => bot.chat('✅ Protect OFF thành công!'));
                }
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!attack':
                const targetPlayer = args[1];
                if (targetPlayer && this.bots.some(bot => bot.player)) {
                    this.executeAttack(targetPlayer);
                    this.bots.forEach(bot => bot.chat(`⚔️ Tấn công ${targetPlayer} thành công!`));
                } else {
                    this.bots.forEach(bot => bot.chat('❌ Lỗi tấn công: Không có bot hoặc target!'));
                }
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!stop':
                this.stopAttack();
                this.bots.forEach(bot => {
                    if (bot.chat) bot.chat('🛑 Dừng tất cả thành công!');
                });
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!cmd':
                const minecraftCommand = args.slice(1).join(' ');
                if (minecraftCommand && this.bots.some(bot => bot.player)) {
                    this.executeCommand(minecraftCommand);
                    this.bots.forEach(bot => bot.chat(`⚡ Thực thi "${minecraftCommand}" thành công!`));
                } else {
                    this.bots.forEach(bot => bot.chat('❌ Lỗi lệnh: Không có bot hoạt động!'));
                }
                this.startCommandPanel(config); // Quay lại panel
                break;
            case '!quit':
                this.bots.forEach(bot => {
                    if (bot.chat) bot.chat('👋 Goodbye master!');
                });
                setTimeout(() => {
                    this.disconnectAllBots();
                    this.startCommandPanel(config); // Quay lại panel
                }, 1000);
                break;
        }
    }

    handleCMDCommands(input, config) {
        const args = input.trim().split(' ');
        const command = args[0].toLowerCase();

        switch (command) {
            case '1': // Chat
                this.rl.question('Nhập tin nhắn (thêm [số] để lặp lại): ', (message) => {
                    const msgArgs = message.trim().split(' ');
                    const chatMessage = msgArgs.slice(0, -1).join(' ') || msgArgs.join(' ');
                    let repeatCount = 1;
                    const lastArg = msgArgs[msgArgs.length - 1];
                    if (!isNaN(lastArg) && lastArg !== chatMessage) {
                        repeatCount = parseInt(lastArg);
                    }
                    if (chatMessage) {
                        this.executeChat(chatMessage, repeatCount);
                    } else {
                        console.log('❌ Thiếu tin nhắn!');
                    }
                    console.log('✅ Thực hiện xong! Quay lại menu...');
                    setTimeout(() => this.startCommandPanel(config), 1000);
                });
                break;

            case '2': // Follow
                this.rl.question('Nhập on/off: ', (followArg) => {
                    if (followArg.toLowerCase() === 'on') {
                        this.followMode = true;
                        this.masterPlayer = config.ownerName;
                        this.bots.forEach(bot => {
                            if (bot.chat) bot.chat('🤖 Follow mode ON!');
                        });
                        console.log(`🎯 Bot follow mode: ON - Theo dõi ${config.ownerName}`);
                        this.bots.forEach(bot => this.followTarget(bot, bot.players[config.ownerName]?.entity));
                    } else if (followArg.toLowerCase() === 'off') {
                        this.followMode = false;
                        this.masterPlayer = null;
                        this.bots.forEach(bot => {
                            if (bot.chat) bot.chat('🤖 Follow mode OFF!');
                            this.stopBotMovement(bot);
                        });
                        console.log('⏹️ Bot follow mode: OFF');
                    }
                    console.log('✅ Thực hiện xong! Quay lại menu...');
                    setTimeout(() => this.startCommandPanel(config), 1000);
                });
                break;

            case '3': // Protect
                this.rl.question('Nhập on/off: ', (protectArg) => {
                    if (protectArg.toLowerCase() === 'on') {
                        this.protectMode = true;
                        this.attackedPlayers.clear();
                        this.bots.forEach(bot => {
                            if (bot.chat) bot.chat('🛡️ PROTECT MODE: ON! Tôi sẽ bảo vệ bạn!');
                        });
                        console.log(`🛡️ PROTECT MODE: ON - Bảo vệ ${config.ownerName}`);
                    } else if (protectArg.toLowerCase() === 'off') {
                        this.protectMode = false;
                        this.attackedPlayers.clear();
                        this.bots.forEach(bot => {
                            if (bot.chat) bot.chat('🛡️ PROTECT MODE: OFF!');
                            this.stopBotMovement(bot);
                        });
                        console.log('🛡️ PROTECT MODE: OFF');
                    }
                    console.log('✅ Thực hiện xong! Quay lại menu...');
                    setTimeout(() => this.startCommandPanel(config), 1000);
                });
                break;

            case '4': // Attack
                this.rl.question('Nhập tên player để tấn công: ', (targetPlayer) => {
                    if (targetPlayer) {
                        this.executeAttack(targetPlayer);
                    } else {
                        console.log('❌ Thiếu tên player! VD: !attack Steve');
                    }
                    console.log('✅ Thực hiện xong! Quay lại menu...');
                    setTimeout(() => this.startCommandPanel(config), 1000);
                });
                break;

            case '5': // Stop
                this.stopAttack();
                console.log('✅ Thực hiện xong! Quay lại menu...');
                setTimeout(() => this.startCommandPanel(config), 1000);
                break;

            case '6': // Command
                this.rl.question('Nhập lệnh Minecraft (VD: gamemode 0): ', (minecraftCommand) => {
                    if (minecraftCommand) {
                        this.executeCommand(minecraftCommand);
                    } else {
                        console.log('❌ Thiếu lệnh! VD: !cmd gamemode 0');
                    }
                    console.log('✅ Thực hiện xong! Quay lại menu...');
                    setTimeout(() => this.startCommandPanel(config), 1000);
                });
                break;

            case '7': // Quit
                this.bots.forEach(bot => {
                    if (bot.chat) bot.chat('👋 Goodbye master!');
                });
                setTimeout(() => {
                    this.disconnectAllBots();
                    this.startCommandPanel(config); // Quay lại panel
                }, 1000);
                break;

            case '0': // Thoát
                console.log('👋 Thoát chương trình...');
                this.disconnectAllBots();
                this.rl.close();
                break;

            default:
                console.log('❌ Lệnh không hợp lệ! Chọn lại (0-7).');
                this.startCommandPanel(config);
        }
    }

    executeChat(message, repeatCount) {
        if (!message || !this.bots.length) return;
        
        console.log(`📢 Gửi tin nhắn "${message}" x${repeatCount}`);
        
        this.bots.forEach((bot, index) => {
            if (bot.chat) {
                for (let i = 0; i < repeatCount; i++) {
                    setTimeout(() => {
                        if (bot.player) bot.chat(message);
                    }, (index * 200) + (i * 600));
                }
            }
        });
    }

    executeAttack(targetPlayerName) {
        if (!targetPlayerName) return;
        
        this.attackMode = true;
        this.attackTarget = targetPlayerName;
        
        console.log(`⚔️ ATTACK MODE: Tấn công ${targetPlayerName} với PvP pro!`);
        
        this.bots.forEach(bot => {
            if (bot.chat) {
                bot.chat(`⚔️ Targeting ${targetPlayerName} with PvP pro!`);
            }
            const targetEntity = bot.players[targetPlayerName]?.entity;
            if (targetEntity) bot.customPvP.attack(targetEntity);
        });
    }

    stopAttack() {
        this.attackMode = false;
        this.attackTarget = null;
        this.protectMode = false;
        this.attackedPlayers.clear();
        
        console.log('🛑 STOP ALL: Dừng tấn công và bảo vệ!');
        
        this.bots.forEach(bot => {
            if (bot.chat) {
                bot.chat('🛑 All modes stopped!');
            }
            bot.customPvP.stop();
            this.stopBotMovement(bot);
        });
    }

    equipBestWeapon(bot) {
        try {
            const weapons = [
                'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
                'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'
            ];
            
            for (const weaponName of weapons) {
                const weapon = bot.inventory.items().find(item => 
                    item.name.includes(weaponName.split('_')[1]) && 
                    (item.name.includes('sword') || item.name.includes('axe'))
                );
                
                if (weapon) {
                    bot.equip(weapon, 'hand');
                    console.log(`⚔️ Bot ${bot.username} trang bị ${weapon.name}`);
                    break;
                }
            }
        } catch (error) {
            console.log(`⚠️ Bot ${bot.username} không có vũ khí`);
        }
    }

    equipBestArmor(bot) {
        try {
            const armorTypes = ['helmet', 'chestplate', 'leggings', 'boots'];
            const armorMaterials = ['netherite', 'diamond', 'iron', 'golden', 'chainmail', 'leather'];

            armorTypes.forEach(type => {
                for (const material of armorMaterials) {
                    const armor = bot.inventory.items().find(item => 
                        item.name.includes(material) && item.name.includes(type)
                    );
                    
                    if (armor) {
                        const destination = type === 'helmet' ? 'head' : 
                                         type === 'chestplate' ? 'torso' : 
                                         type === 'leggings' ? 'legs' : 'feet';
                        bot.equip(armor, destination);
                        console.log(`🛡️ Bot ${bot.username} trang bị ${armor.name}`);
                        break;
                    }
                }
            });
        } catch (error) {
            console.log(`⚠️ Bot ${bot.username} không có giáp`);
        }
    }

    executeCommand(command) {
        if (!command || !this.bots.length) return;
        
        console.log(`⚡ Thực thi lệnh "/${command}"`);
        
        this.bots.forEach((bot, index) => {
            if (bot.chat) {
                setTimeout(() => {
                    if (bot.player) bot.chat(`/${command}`);
                }, index * 300);
            }
        });
    }

    addBasicFeatures(bot, botName, config) {
        bot.on('physicsTick', () => {
            if (this.attackMode && this.attackTarget) {
                const targetEntity = bot.players[this.attackTarget]?.entity;
                if (targetEntity) bot.customPvP.attack(targetEntity);
            } else if (this.followMode && this.masterPlayer && bot.players[this.masterPlayer] && !this.protectMode) {
                this.followTarget(bot, bot.players[this.masterPlayer].entity);
            }
        });

        setInterval(() => {
            if (!this.followMode && !this.attackMode && !this.protectMode && bot.entity && Math.random() < 0.05) {
                const controls = ['forward', 'back', 'left', 'right'];
                const randomControl = controls[Math.floor(Math.random() * controls.length)];
                
                bot.setControlState(randomControl, true);
                setTimeout(() => {
                    bot.setControlState(randomControl, false);
                }, Math.random() * 2000 + 1000);
            }
        }, 10000);
    }

    followTarget(bot, targetEntity) {
        if (!targetEntity || !bot.entity) return;

        const distance = bot.entity.position.distanceTo(targetEntity.position);
        if (distance > 3) {
            const dx = targetEntity.position.x - bot.entity.position.x;
            const dz = targetEntity.position.z - bot.entity.position.z;
            const angle = Math.atan2(dz, dx) * 180 / Math.PI;

            bot.lookAt(targetEntity.position.offset(0, targetEntity.height * 0.8, 0));
            bot.setControlState('sprint', true); // Sprint thay cho đi bộ
            bot.setControlState('forward', true);

            if (angle > 45 && angle <= 135) {
                bot.setControlState('left', true);
            } else if (angle > -135 && angle <= -45) {
                bot.setControlState('right', true);
            } else {
                bot.setControlState('left', false);
                bot.setControlState('right', false);
            }

            if (distance > 5 && bot.entity.onGround) {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 300);
            }
        } else {
            this.stopBotMovement(bot);
        }
    }

    stopBotMovement(bot) {
        ['forward', 'back', 'left', 'right', 'jump', 'sprint'].forEach(control => {
            bot.setControlState(control, false);
        });
        if (bot.pathfinder) {
            bot.pathfinder.setGoal(null);
        }
    }

    async spawnBots() {
        try {
            const config = await this.getUserInput();
            this.ownerUsername = config.ownerName;
            
            console.log(`\n🚀 Bắt đầu spawn ${config.botCount} bot với PvP pro!`);
            console.log(`🎮 Server: ${config.host}:${config.port}`);
            console.log(`📝 Tên bot: ${config.botNamePrefix}1, ${config.botNamePrefix}2, ...`);
            console.log(`🎮 Version: ${config.version}`);
            console.log(`👑 OWNER: ${config.ownerName} (chỉ owner mới điều khiển được)`);
            console.log(`👤 Master player: ${config.masterName}\n`);

            const botPromises = [];
            for (let i = 1; i <= config.botCount; i++) {
                botPromises.push(
                    this.createBot(config, i).catch(error => {
                        console.log(`⚠️ Bot ${i} không thể kết nối: ${error.message}`);
                        return null;
                    })
                );
                
                if (i < config.botCount) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            const results = await Promise.allSettled(botPromises);
            this.bots = results
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            console.log(`\n✅ Đã spawn thành công ${this.bots.length}/${config.botCount} bot!`);
            
            if (this.bots.length === 0) {
                console.log('⚠️ Không có bot nào kết nối thành công, nhưng sẽ tiếp tục thử.');
            }

            this.showHelp();
            this.startCommandPanel(config);
        } catch (error) {
            console.log(`❌ Lỗi khi spawn bot: ${error.message}`);
            this.startCommandPanel(config); // Quay lại panel nếu lỗi
        }
    }

    showHelp() {
        console.log('\n📜 HƯỚNG DẪN SỬ DỤNG (qua CMD hoặc Chat, chỉ OWNER có thể điều khiển):');
        console.log('!chat <message> [count] - Gửi tin nhắn x số lần');
        console.log('!follow on/off - Bật/tắt chế độ follow master player');
        console.log('!protect on/off - Bật/tắt chế độ bảo vệ owner');
        console.log('!attack <player> - Tấn công player được chỉ định');
        console.log('!stop - Dừng tất cả hành động (attack/protect/follow)');
        console.log('!cmd <command> - Thực thi lệnh Minecraft (VD: gamemode 0)');
        console.log('!quit - Ngắt kết nối tất cả bot');
        console.log('\n📢 CMD commands (gõ số tương ứng):');
        console.log('1. Chat');
        console.log('2. Follow');
        console.log('3. Protect');
        console.log('4. Attack');
        console.log('5. Stop');
        console.log('6. Command');
        console.log('7. Quit');
        console.log('0. Thoát chương trình');
    }

    startCommandPanel(config) {
        const handleCommand = (input) => {
            this.handleCMDCommands(input, config);
        };

        console.log('\n🎮 === PANEL ĐIỀU KHIỂN BOT ===');
        this.showHelp();
        this.rl.question('Nhập số lệnh (0-7): ', handleCommand);
    }

    disconnectAllBots() {
        this.bots.forEach(bot => {
            try {
                bot.quit();
            } catch (error) {
                // Ignore errors
            }
        });
        this.bots = [];
        console.log('👋 Tất cả bot đã ngắt kết nối!');
        this.startCommandPanel(config); // Quay lại panel
    }

    async start() {
        console.log('🤖 Minecraft Bot Spawner - PvP Pro VIP Edition');
        console.log('==========================================');
        await this.spawnBots();
    }
}

// Khởi chạy bot spawner
const spawner = new MinecraftBotSpawner();
spawner.start().catch(error => {
    console.error(`❌ Lỗi khởi động: ${error.message}`);
    spawner.startCommandPanel(); // Quay lại panel nếu lỗi khởi động
});