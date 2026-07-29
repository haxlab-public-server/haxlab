module.exports = function createCommands({
    Role,
    muteDuration,
    leaveCommand,
    helpCommand,
    globalStatsCommand,
    renameCommand,
    customColorsCommand,
    linkDiscordCommand,
    statsLeaderboardCommand,
    afkCommand,
    afkListCommand, 
    restartCommand,
    restartSwapCommand,
    swapCommand,
    kickTeamCommand,
    stadiumCommand,
    muteCommand,
    unmuteCommand,
    muteListCommand,
    hideCommand,
    clearbansCommand,
    banListCommand,
    adminListCommand,
    setAdminCommand,
    removeAdminCommand,
    setVipCommand,
    removeVipCommand,
    vipListCommand,
    banAuthCommand,
    unbanAuthCommand,
    authBanListCommand,
    playersListCommand,
    passwordCommand,
    teamChat,
    shopCommand,
    inventoryCommand,
    equipCommand,
    unequipCommand,
    addCoinsCommand,
    balanceCommand,
    clubCreateCommand,
    clubInviteCommand,
    clubJoinCommand,
    clubLeaveCommand,
    clubKickCommand,
    clubAssistantCommand,
    clubDisbandCommand,
    clubColorCommand,
    clubEmojiCommand,
    clubSlotsCommand,
    clubInfoCommand,
    clubHelpCommand,
    trophiesCommand,
}) {
    return {

    help: {
        aliases: ['commands', 'рудз'],
        roles: Role.PLAYER,
        desc: `
	Эта команда показывает все доступные вам команды. Она также может показать описание конкретной команды.
Например: !help bb покажет описание команды bb.`,
        function: helpCommand,
    },
    afk: {
        aliases: ['афк', 'фал'],
        roles: Role.PLAYER,
        desc: `
        Эта команда делает вас AFK.
    Она имеет определенные ограничения: 1 минута минимального AFK времени, 5 минут максимальное и 10 минут перезарядки.`,
        function: afkCommand,
    },
    afks: {
        aliases: ['afklist', 'фалы'],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает всех игроков, которые находятся AFK.`,
        function: afkListCommand,
    },
    bb: {
        aliases: ['bye', 'gn', 'cya', 'ии'],
        roles: Role.PLAYER,
        desc: `
	Эта команда мгновенно выводит вас из комнаты (рекомендуется использовать).`,
        function: leaveCommand,
    },
    me: {
        aliases: ['stat', 'stats', 'ы', 's'],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает ваши глобальные статистики в комнате.`,
        function: globalStatsCommand,
    },
    rename: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда позволяет вам переименовать себя для таблицы лидеров.`,
        function: renameCommand,
    },
    customcolors: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда переключает, видите ли ВЫ кастомные цвета клубов в чате. Не влияет на то, что видят другие игроки.`,
        function: customColorsCommand,
    },
    discord: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда связывает ваш аккаунт Discord, чтобы "!stats" в Discord показывал ваши статистики без необходимости вводить ваше имя.
    Она требует 1 аргумент:
    Аргумент 1: <id> где <id> это ваш ID пользователя Discord (включите Режим разработчика в настройках Discord, затем кликните правой кнопкой мыши на вашем имени и выберите "Копировать ID пользователя").
    Пример: !discord 123456789012345678 связывает ваш аккаунт Discord.`,
        function: linkDiscordCommand,
    },
    games: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим количеством игр в комнате.`,
        function: statsLeaderboardCommand,
    },
    wins: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим количеством побед в комнате.`,
        function: statsLeaderboardCommand,
    },
    goals: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим количеством голов в комнате.`,
        function: statsLeaderboardCommand,
    },
    assists: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим количеством ассистов в комнате.`,
        function: statsLeaderboardCommand,
    },
    cs: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим количеством сухих матчей в комнате.`,
        function: statsLeaderboardCommand,
    },
    playtime: {
        aliases: ['pt'],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает топ 5 игроков с самым большим временем игры в комнате.`,
        function: statsLeaderboardCommand,
    },
    x: {
        aliases: ['ч'],
        roles: Role.PLAYER,
        desc: `
        Эта команда отправляет сообщение только вашей команде (работает так же, как обычный командный чат — набрать "t <сообщение>").
    Пример: !x привет отправит "привет" только вашей команде.`,
        function: teamChat,
    },
    shop: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Без аргументов показывает магазин и ваш баланс монеток.
    Она принимает 1 аргумент (опционально):
    Аргумент 1: <id> id товара для покупки (посмотреть можно командой '!shop' без аргументов).
    Пример: !shop fire купит товар с id "fire".`,
        function: shopCommand,
    },
    inventory: {
        aliases: ['inv'],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает купленные вами аксессуары.`,
        function: inventoryCommand,
    },
    balance: {
        aliases: ['bal', 'coins'],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает ваш баланс монеток.`,
        function: balanceCommand,
    },
    equip: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда надевает (или заменяет) купленный аксессуар.
    Она принимает 1 аргумент:
    Аргумент 1: <id> id аксессуара (посмотреть можно командой '!inventory').
    Пример: !equip fire наденет аксессуар с id "fire".`,
        function: equipCommand,
    },
    unequip: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда снимает надетый аксессуар.
    Она принимает 1 аргумент:
    Аргумент 1: <id> id аксессуара (посмотреть можно командой '!inventory').
    Пример: !unequip fire снимет аксессуар с id "fire", если он сейчас надет.`,
        function: unequipCommand,
    },
    training: {
        aliases: ['tr'],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда загружает классическую тренировочную арену.`,
        function: stadiumCommand,
    },
    classic: {
        aliases: ['cl'],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда загружает классическую арену.`,
        function: stadiumCommand,
    },
    big: {
        aliases: ['bg'],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда загружает большую арену.`,
        function: stadiumCommand,
    },
    rr: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда перезапускает игру.`,
        function: restartCommand,
    },
    rrs: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда меняет команды местами и перезапускает игру.`,
        function: restartSwapCommand,
    },
    swap: {
        aliases: ['s'],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда меняет команды местами, когда игра остановлена.`,
        function: swapCommand,
    },
    kickred: {
        aliases: ['kickr'],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда выгоняет всех игроков из красной команды, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    kickblue: {
        aliases: ['kickb'],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда выгоняет всех игроков из синей команды, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    kickspec: {
        aliases: ['kicks'],
        roles: Role.ADMIN_TEMP,
        desc: `
    Эта команда выгоняет всех игроков из команды наблюдателей, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    mute: {
        aliases: ['m'],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда позволяет заглушить игрока. Он не сможет говорить в течение определенного времени, и может быть разглушен в любое время администраторами.
    Она принимает 2 аргумента:
    Аргумент 1: #<id> где <id> это id целевого игрока. Это не будет работать, если игрок является администратором.
    Аргумент 2 (опционально): <duration> где <duration> это продолжительность заглушения в минутах. Если значение не указано, заглушение длится по умолчанию, ${muteDuration} минут.
    Например: !mute #3 10 заглушит игрока с id 3 на 10 минут.`,
        function: muteCommand,
    },
    unmute: {
        aliases: ['um'],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда позволяет разглушить игрока.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id заглушенного игрока.
    ИЛИ
    Аргумент 1: <number> где <number> это номер, связанный с заглушением, данным командой 'muteList'.
    Пример: !unmute #300 разглушит игрока с id 300,
             !unmute 8 разглушит игрока с заглушением №8 согласно команде 'muteList'.`,
        function: unmuteCommand,
    },
    mutes: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда показывает список заглушенных игроков.`,
        function: muteListCommand,
    },
    hide: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        desc: `
        Эта команда скрывает (или снова показывает) ваш бейдж администратора и префикс в чате. Права доступа не меняются, только видимость.`,
        function: hideCommand,
    },
    clearbans: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
	Эта команда разбанивает всех игроков, которые были забанены.`,
        function: clearbansCommand,
    },
    bans: {
        aliases: ['banlist'],
        roles: Role.MASTER,
        desc: `
    Эта команда показывает всех игроков, которые были забанены, и их IDs.`,
        function: banListCommand,
    },
    admins: {
        aliases: ['adminlist'],
        roles: Role.MASTER,
        desc: `
    Эта команда показывает всех игроков, которые являются постоянными администраторами.`,
        function: adminListCommand,
    },
    setadmin: {
        aliases: ['admin'],
        roles: Role.MASTER,
        desc: `
    Эта команда позволяет установить кого-то в качестве администратора. Он сможет подключаться как администратор и может быть удален в любое время мастерами.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    Пример: !setadmin #3 предоставит админку игроку с id 3.`,
        function: setAdminCommand,
    },
    removeadmin: {
        aliases: ['unadmin'],
        roles: Role.MASTER,
        desc: `
	Эта команда позволяет удалить кого-то из администраторов.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    ИЛИ
    Аргумент 1: <number> где <number> это номер, связанный с администратором, данным командой 'admins'.
    Пример: !removeadmin #300 удалит администратора с id 300,
         !removeadmin 2 удалит администратора с номером 2 согласно команде 'admins'.`,
        function: removeAdminCommand,
    },
    setvip: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Эта команда делает кого-то VIP. Это не дает никаких прав — только префикс "VIP" в чате.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    Пример: !setvip #3 сделает игрока с id 3 VIP.`,
        function: setVipCommand,
    },
    removevip: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
	Эта команда убирает у кого-то VIP.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    ИЛИ
    Аргумент 1: <number> где <number> это номер, связанный с VIP игроком, данным командой 'vips'.
    Пример: !removevip #300 уберет VIP у игрока с id 300,
         !removevip 2 уберет VIP у игрока с номером 2 согласно команде 'vips'.`,
        function: removeVipCommand,
    },
    vips: {
        aliases: ['viplist'],
        roles: Role.MASTER,
        desc: `
    Эта команда показывает всех игроков, у которых есть VIP.`,
        function: vipListCommand,
    },
    banauth: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Эта команда банит по auth — работает даже если игрок сейчас не в комнате, и переживает переподключение под тем же auth (в отличие от обычного бана).
    Она принимает от 2 до 3 аргументов:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую (посмотреть можно командой '!players' или в чате при входе/выходе) — работает даже если он не в комнате.
    Аргумент 2: <минуты> длительность бана в минутах — обязательна, постоянных банов через эту команду больше нет.
    Аргумент 3 (опционально): <reason> причина бана.
    Пример: !banauth #3 60 читер забанит игрока с id 3 на 60 минут с причиной "читер".`,
        function: banAuthCommand,
    },
    ban: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        desc: `
    То же самое, что '!banauth', но доступно администраторам, а не только владельцам.
    Она принимает от 2 до 3 аргументов:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую — работает даже если он не в комнате.
    Аргумент 2: <минуты> длительность бана в минутах — обязательна.
    Аргумент 3 (опционально): <reason> причина бана.
    Пример: !ban #3 60 читер забанит игрока с id 3 на 60 минут с причиной "читер".`,
        function: banAuthCommand,
    },
    unbanauth: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Эта команда снимает бан по auth, выданный командой '!banauth'.
    Она принимает 1 аргумент:
    Аргумент 1: <auth> auth забаненного игрока.`,
        function: unbanAuthCommand,
    },
    authbans: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Эта команда показывает список игроков, забаненных по auth командой '!banauth'.`,
        function: authBanListCommand,
    },
    players: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Эта команда показывает список всех игроков в комнате вместе с их auth — удобно, чтобы затем забанить кого-то по auth командой '!banauth'.`,
        function: playersListCommand,
    },
    password: {
        aliases: ['pw'],
        roles: Role.MASTER,
        desc: `
        Эта команда позволяет добавить пароль к комнате.
    Она принимает 1 аргумент:
    Аргумент 1: <password> где <password> это пароль, который вы хотите для комнаты.

    Чтобы удалить пароль комнаты, просто введите '!password'.`,
        function: passwordCommand,
    },
    addcoins: {
        aliases: [],
        roles: Role.MASTER,
        desc: `
    Тестовая команда: начисляет (или списывает) монетки игроку напрямую.
    Она принимает 2 аргумента:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую.
    Аргумент 2: <количество> сколько монеток начислить — можно отрицательное число, чтобы списать.
    Пример: !addcoins #3 500 начислит 500 монет игроку с id 3.`,
        function: addCoinsCommand,
    },
    clubcreate: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubCreateCommand,
    },
    clubinvite: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubInviteCommand,
    },
    clubjoin: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubJoinCommand,
    },
    clubleave: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubLeaveCommand,
    },
    clubkick: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubKickCommand,
    },
    clubassistent: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubAssistantCommand,
    },
    clubdisband: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubDisbandCommand,
    },
    clubcolor: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubColorCommand,
    },
    clubemoji: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubEmojiCommand,
    },
    clubslots: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubSlotsCommand,
    },
    club: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `Смотрите "!clubhelp" для информации.`,
        function: clubInfoCommand,
    },
    clubhelp: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает все команды клуба и как ими пользоваться.`,
        function: clubHelpCommand,
    },
    trophy: {
        aliases: [],
        roles: Role.PLAYER,
        desc: `
        Эта команда показывает ваши трофеи (за топ-3 место в статистике) и позволяет экипировать один из них в качестве префикса в чате.
    Она принимает 1 аргумент (опционально):
    Аргумент 1: <трофей> где <трофей> один из: goals, assists, cs, wr, pt. Или "none", чтобы снять текущий трофей.
    Пример: !trophy goals экипирует трофей "🥇Топ-1 голов" (или 🥈/🥉 в зависимости от вашего текущего места), если вы сейчас в топ-3 по голам.`,
        function: trophiesCommand,
    },

    };
};
