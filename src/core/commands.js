module.exports = function createCommands({
    Role,
    muteDuration,
    leaveCommand,
    helpCommand,
    globalStatsCommand,
    vsCommand,
    tipCommand,
    renameCommand,
    customColorsCommand,
    vipColorCommand,
    vipHideCommand,
    vipHelpCommand,
    linkDiscordCommand,
    linkTelegramCommand,
    topsCommand,
    afkCommand,
    afkListCommand,
    silenceCommand,
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
    restrictCmdCommand,
    unrestrictCmdCommand,
    cmdRestrictionsCommand,
    playersListCommand,
    passwordCommand,
    teamChat,
    shopCommand,
    inventoryCommand,
    equipCommand,
    addCoinsCommand,
    giftCoinsCommand,
    balanceCommand,
    clubCommand,
    clubChatCommand,
    trophiesCommand,
    votepauseCommand,
    votebanCommand,
    reportCommand,
    upCommand,
    minigamesCommand,
    playCommand,
    hitCommand,
    standCommand,
    betCommand,
    callCommand,
    checkCommand,
    passCommand,
    leaveTableCommand,
    tablePlayersCommand,
}) {
    return {

    help: {
        aliases: ['commands', 'рудз'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
	Эта команда показывает все доступные вам команды. Она также может показать описание конкретной команды.
Например: !help bb покажет описание команды bb.`,
        function: helpCommand,
    },
    afk: {
        aliases: ['афк', 'фал'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда делает вас AFK.
    Она имеет определенные ограничения: 1 минута минимального AFK времени, 15 минут максимальное (25 для VIP) и 10 минут перезарядки.
    Одновременно AFK может быть не больше 4 игроков (5, если вы VIP — для вас есть дополнительное место). Админы вообще не ограничены этим лимитом.
    Чтобы быстро выйти из AFK, можно также просто написать "jj" (без "!").`,
        function: afkCommand,
    },
    afks: {
        aliases: ['afklist', 'фалы'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда показывает всех игроков, которые находятся AFK.`,
        function: afkListCommand,
    },
    silence: {
        aliases: ['ignore'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда заглушает игрока ТОЛЬКО ДЛЯ ВАС — вы больше не будете видеть его сообщения в чате, но все остальные продолжат их видеть как обычно. Повторный ввод команды на того же игрока снимает заглушение.
    Нельзя заглушить самого себя, а также администраторов и модераторов.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    Пример: !silence #3 заглушит игрока с id 3 только для вас.`,
        function: silenceCommand,
    },
    bb: {
        aliases: ['bye', 'gn', 'cya', 'ии'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
	Эта команда мгновенно выводит вас из комнаты (рекомендуется использовать).`,
        function: leaveCommand,
    },
    me: {
        aliases: ['stat', 'stats', 'ы', 's'],
        roles: Role.PLAYER,
        category: 'stats',
        desc: `
        Эта команда показывает ваши глобальные статистики в комнате.`,
        function: globalStatsCommand,
    },
    vs: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'stats',
        desc: `
        Эта команда сравнивает вашу статистику со статистикой другого игрока — построчно, кто впереди.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id игрока для сравнения.
    Пример: !vs #3 сравнит вашу статистику с игроком с id 3.`,
        function: vsCommand,
    },
    tip: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда публично благодарит другого игрока за игру ("👏 вы благодарит(е) игрока. Хорошая игра!").
    Не больше 1 раза за матч, и не больше 5 раз в день (10 раз для VIP).
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id игрока, которого вы благодарите.
    Пример: !tip #3 благодарит игрока с id 3.`,
        function: tipCommand,
    },
    rename: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'stats',
        desc: `
        Эта команда позволяет вам переименовать себя для таблицы лидеров.`,
        function: renameCommand,
    },
    customcolors: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда переключает, видите ли ВЫ кастомные цвета клубов в чате. Не влияет на то, что видят другие игроки.`,
        function: customColorsCommand,
    },
    vipcolor: {
        aliases: [],
        roles: Role.VIP,
        category: 'vip',
        desc: `
        Эта команда позволяет вам изменить цвет вашего VIP-префикса в чате.
    Она принимает 1 аргумент (опционально):
    Аргумент 1: <hex> цвет в hex-формате. Без аргумента цвет сбрасывается на стандартный.
    Пример: !vipcolor ff8800.`,
        function: vipColorCommand,
    },
    viphide: {
        aliases: [],
        roles: Role.VIP,
        category: 'vip',
        desc: `
        Эта команда скрывает (или снова показывает) ваш VIP-префикс в чате. Права доступа не меняются, только видимость.`,
        function: vipHideCommand,
    },
    viphelp: {
        aliases: [],
        roles: Role.VIP,
        category: 'vip',
        desc: `
        Эта команда показывает все команды VIP и как ими пользоваться.`,
        function: vipHelpCommand,
    },
    up: {
        aliases: [],
        roles: Role.VIP,
        category: 'vip',
        desc: `
        Эта команда позволяет вам стать капитаном раньше остальных зрителей, когда в следующий раз потребуется выбрать капитана.
    Недоступна, пока капитаны прямо сейчас выбирают игроков. Только 1 VIP может занять очередь одновременно — остальные ждут следующей итерации.
    Доступна раз в час, не больше 3 раз в день — если сейчас на перезарядке или лимит исчерпан, команда сама покажет, сколько осталось ждать.`,
        function: upCommand,
    },
    discord: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда связывает ваш аккаунт Discord, чтобы "!stats" в Discord показывал ваши статистики без необходимости вводить ваше имя. За первую привязку начисляется бонус 100 монет.
    Она требует 1 аргумент:
    Аргумент 1: <id> где <id> это ваш ID пользователя Discord (включите Режим разработчика в настройках Discord, затем кликните правой кнопкой мыши на вашем имени и выберите "Копировать ID пользователя").
    Пример: !discord 123456789012345678 связывает ваш аккаунт Discord.`,
        function: linkDiscordCommand,
    },
    telegram: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда связывает ваш аккаунт Telegram, чтобы VIP мог получить текущий пароль от заполненной комнаты через бота командой /pass, не заходя в Discord.
    Без аргумента: показывает код для команды /link в боте Telegram.
    С аргументом: завершает привязку кодом, который бот прислал на команду /start.
    Пример: !telegram связывает аккаунт (шаг 1). !telegram AB12CD34 завершает привязку кодом из Telegram (шаг 2, если начали с /start).`,
        function: linkTelegramCommand,
    },
    tops: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'stats',
        desc: `
        Эта команда показывает таблицы лидеров (топ 5 игроков) комнаты.
    Без аргумента показывает все таблицы сразу: игры, победы, голы, ассисты, сухие матчи, время игры, ELO и клубы.
    Она принимает 1 аргумент (опционально):
    Аргумент 1: <категория> где <категория> одна из: games, wins, goals, assists, cs, playtime (или pt), elo, clubs.
    Пример: !tops goals покажет только таблицу лидеров по голам.
    Пример: !tops clubs покажет топ-5 клубов по сумме голов+ассистов+сухих матчей их ТЕКУЩИХ участников (вышедшие из клуба не в счет).`,
        function: topsCommand,
    },
    x: {
        aliases: ['ч'],
        roles: Role.PLAYER,
        category: 'chat',
        desc: `
        Эта команда отправляет сообщение только вашей команде (работает так же, как обычный командный чат — набрать "t <сообщение>", "т <сообщение>" или "ч <сообщение>" без "!").
    Пример: !x привет отправит "привет" только вашей команде.`,
        function: teamChat,
    },
    cc: {
        aliases: ['сс'],
        roles: Role.PLAYER,
        category: 'chat',
        desc: `
        Эта команда отправляет сообщение всем участникам вашего клуба, которые сейчас на сервере (работает так же, как !x, только для клуба вместо команды).
    Пример: !cc привет отправит "привет" всем участникам вашего клуба онлайн.`,
        function: clubChatCommand,
    },
    shop: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'shop',
        desc: `
        Без аргументов показывает список категорий и ваш баланс монеток.
    Она принимает 1 аргумент (опционально):
    Аргумент 1: <категория> (form/size/avatar/goalAnimation) — список товаров этой категории, ИЛИ <id> товара для покупки.
    Пример: !shop form покажет все товары категории "form". !shop fire купит товар с id "fire".
    Товары "small" и "big" — улучшаемые (5 уровней, ±2 к радиусу шара за уровень от стандартных 15): повторный '!shop small'/'!shop big' повышает уровень вместо отказа "уже куплено", а цена растет на 100 монет за уровень.`,
        function: shopCommand,
    },
    inventory: {
        aliases: ['inv'],
        roles: Role.PLAYER,
        category: 'shop',
        desc: `
        Эта команда показывает купленные вами аксессуары.`,
        function: inventoryCommand,
    },
    balance: {
        aliases: ['bal', 'coins'],
        roles: Role.PLAYER,
        category: 'shop',
        desc: `
        Эта команда показывает ваш баланс монеток.`,
        function: balanceCommand,
    },
    equip: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'shop',
        desc: `
        Эта команда надевает (или заменяет) купленный аксессуар. Повторный ввод той же команды на уже надетый аксессуар снимает его.
    Она принимает 1 аргумент:
    Аргумент 1: <id> id аксессуара (посмотреть можно командой '!inventory').
    Пример: !equip fire наденет аксессуар с id "fire", повторный !equip fire снимет его.`,
        function: equipCommand,
    },
    training: {
        aliases: ['tr'],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
        Эта команда загружает классическую тренировочную арену.`,
        function: stadiumCommand,
    },
    classic: {
        aliases: ['cl'],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
        Эта команда загружает классическую арену.`,
        function: stadiumCommand,
    },
    big: {
        aliases: ['bg'],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
        Эта команда загружает большую арену.`,
        function: stadiumCommand,
    },
    rr: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
    Эта команда перезапускает игру.`,
        function: restartCommand,
    },
    rrs: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
    Эта команда меняет команды местами и перезапускает игру.`,
        function: restartSwapCommand,
    },
    swap: {
        aliases: ['s'],
        roles: Role.ADMIN_TEMP,
        category: 'arena',
        desc: `
    Эта команда меняет команды местами, когда игра остановлена.`,
        function: swapCommand,
    },
    kickred: {
        aliases: ['kickr'],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда выгоняет всех игроков из красной команды, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    kickblue: {
        aliases: ['kickb'],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда выгоняет всех игроков из синей команды, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    kickspec: {
        aliases: ['kicks'],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда выгоняет всех игроков из команды наблюдателей, включая игрока, который ввел команду. Вы можете указать причину выгона в качестве аргумента.`,
        function: kickTeamCommand,
    },
    mute: {
        aliases: ['m'],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
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
        category: 'moderation',
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
        category: 'moderation',
        desc: `
        Эта команда показывает список заглушенных игроков.`,
        function: muteListCommand,
    },
    hide: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
        Эта команда скрывает (или снова показывает) ваш бейдж администратора и префикс в чате. Права доступа не меняются, только видимость.`,
        function: hideCommand,
    },
    clearbans: {
        aliases: [],
        roles: Role.MASTER,
        category: 'moderation',
        desc: `
	Эта команда разбанивает всех игроков, которые были забанены.`,
        function: clearbansCommand,
    },
    bans: {
        aliases: ['banlist'],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда показывает всех игроков, которые были забанены, и их IDs.`,
        function: banListCommand,
    },
    admins: {
        aliases: ['adminlist'],
        roles: Role.MASTER,
        category: 'moderation',
        desc: `
    Эта команда показывает всех игроков, которые являются постоянными администраторами.`,
        function: adminListCommand,
    },
    setadmin: {
        aliases: ['admin'],
        roles: Role.MASTER,
        category: 'moderation',
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
        category: 'moderation',
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
        category: 'vip',
        desc: `
    Эта команда делает кого-то VIP. Это не дает никаких прав — только префикс "VIP" в чате.
    Она принимает от 1 до 2 аргументов:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую — работает даже если он не в комнате.
    Аргумент 2 (опционально): <дни> на сколько дней выдать VIP. Если не указано, VIP выдается навсегда.
    Пример: !setvip #3 сделает игрока с id 3 VIP навсегда,
             !setvip #3 30 сделает игрока с id 3 VIP на 30 дней,
             !setvip AUTH_XYZ 30 сделает VIP на 30 дней игрока с auth "AUTH_XYZ", даже если он сейчас не в комнате.`,
        function: setVipCommand,
    },
    removevip: {
        aliases: [],
        roles: Role.MASTER,
        category: 'vip',
        desc: `
	Эта команда убирает у кого-то VIP.
    Она принимает 1 аргумент:
    Аргумент 1: #<id> где <id> это id целевого игрока.
    ИЛИ
    Аргумент 1: <auth> — работает даже если игрок сейчас не в комнате.
    ИЛИ
    Аргумент 1: <number> где <number> это номер, связанный с VIP игроком, данным командой 'vips'.
    Пример: !removevip #300 уберет VIP у игрока с id 300,
         !removevip AUTH_XYZ уберет VIP по auth "AUTH_XYZ", даже если игрок сейчас не в комнате,
         !removevip 2 уберет VIP у игрока с номером 2 согласно команде 'vips'.`,
        function: removeVipCommand,
    },
    vips: {
        aliases: ['viplist'],
        roles: Role.MASTER,
        category: 'vip',
        desc: `
    Эта команда показывает всех игроков, у которых есть VIP.`,
        function: vipListCommand,
    },
    banauth: {
        aliases: [],
        roles: Role.MASTER,
        category: 'moderation',
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
        category: 'moderation',
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
        category: 'moderation',
        desc: `
    Эта команда снимает бан по auth, выданный командой '!banauth'.
    Она принимает 1 аргумент:
    Аргумент 1: <auth|номер> auth забаненного игрока, ИЛИ номер [i] из списка "!authbans" — так проще, чем вводить auth целиком.
    Пример: !unbanauth 2 снимает бан с игрока под номером [2] в "!authbans".`,
        function: unbanAuthCommand,
    },
    authbans: {
        aliases: [],
        roles: Role.MASTER,
        category: 'moderation',
        desc: `
    Эта команда показывает список игроков, забаненных по auth командой '!banauth', с номером [i] у каждого — его можно передать в "!unbanauth" вместо auth.`,
        function: authBanListCommand,
    },
    restrictcmd: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда запрещает игроку использовать !voteban или !report — на время или навсегда. Работает по auth (переживает выход/переподключение), даже если игрок сейчас не в комнате.
    Она принимает от 3 до 4 аргументов:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую.
    Аргумент 2: <voteban|report> какую команду запретить.
    Аргумент 3: <минуты> — 0 означает навсегда.
    Аргумент 4 (опционально): <reason> причина.
    Пример: !restrictcmd #3 report 60 спам запретит игроку с id 3 использовать !report на 60 минут с причиной "спам".
    Пример: !restrictcmd #3 voteban 0 запретит !voteban навсегда.`,
        function: restrictCmdCommand,
    },
    unrestrictcmd: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда снимает запрет, выданный командой '!restrictcmd'.
    Она принимает 2 аргумента:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую.
    Аргумент 2: <voteban|report> с какой команды снять запрет.
    Пример: !unrestrictcmd #3 report снимет запрет на !report с игрока с id 3.`,
        function: unrestrictCmdCommand,
    },
    cmdrestrictions: {
        aliases: [],
        roles: Role.ADMIN_TEMP,
        category: 'moderation',
        desc: `
    Эта команда показывает список всех текущих запретов, выданных командой '!restrictcmd'.`,
        function: cmdRestrictionsCommand,
    },
    players: {
        aliases: [],
        roles: Role.MASTER,
        category: 'moderation',
        desc: `
    Эта команда показывает список всех игроков в комнате вместе с их auth — удобно, чтобы затем забанить кого-то по auth командой '!banauth'.`,
        function: playersListCommand,
    },
    password: {
        aliases: ['pw'],
        roles: Role.MASTER,
        category: 'arena',
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
        category: 'shop',
        desc: `
    Тестовая команда: начисляет (или списывает) монетки игроку напрямую.
    Она принимает 2 аргумента:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую.
    Аргумент 2: <количество> сколько монеток начислить — можно отрицательное число, чтобы списать.
    Пример: !addcoins #3 500 начислит 500 монет игроку с id 3.`,
        function: addCoinsCommand,
    },
    gift: {
        aliases: ['подарить'],
        roles: Role.ADMIN_TEMP,
        category: 'shop',
        desc: `
        Эта команда дарит игроку монеты — они списываются с ВАШЕГО баланса, а не создаются из ниоткуда (в отличие от !addcoins).
    Она принимает 2 аргумента:
    Аргумент 1: #<id> игрока, который сейчас в комнате, ИЛИ его <auth> напрямую.
    Аргумент 2: <количество> сколько монет подарить — только положительное число.
    Пример: !gift #3 500 подарит 500 монет игроку с id 3 из вашего баланса.`,
        function: giftCoinsCommand,
    },
    club: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'club',
        desc: `
        Команда клуба — принимает подкоманду первым аргументом.
    Введите "!club help" для полного списка подкоманд (create/invite/join/leave/kick/assistant/disband/color/colors/emoji/slots).
    Без аргумента — то же самое, что "!club show" (показывает информацию о вашем клубе).`,
        function: clubCommand,
    },
    trophy: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'stats',
        desc: `
        Эта команда показывает ваши трофеи (за топ-3 место в статистике) и позволяет экипировать один из них в качестве префикса в чате.
    Она принимает до 2 аргументов (оба опциональны):
    Аргумент 1: <трофей> где <трофей> один из: goals, assists, cs, wr, pt. Или "none", чтобы снять текущий трофей.
    Аргумент 2: <сезон> — номер прошлого (уже завершенного) сезона, чтобы экипировать трофей за него вместо текущего.
    Пример: !trophy goals экипирует трофей текущего сезона "🥇Топ-1 голов S1" (или 🥈/🥉 в зависимости от вашего текущего места), если вы сейчас в топ-3 по голам.
    Пример: !trophy goals 0 экипирует трофей "🥇Топ-1 голов S0" за сезон 0, если вы держали это место на момент его завершения.`,
        function: trophiesCommand,
    },
    votepause: {
        aliases: ['голос'],
        roles: Role.PLAYER,
        category: 'votes',
        desc: `
        Эта команда позволяет игрокам на поле начать голосование команды за паузу.
    Доступно только в полных матчах 4х4 (с капитан-модом) и только на кикоффе (пока мяч не тронут).
    Нужно 3/4 голосов "за" от вашей команды, доступно 1 раз за матч на команду.
    Игроки команды голосуют, написав в чат "1" (за) или "2" (против), в течение 7 секунд.
    Пример: !votepause начнет голосование за 20-секундную паузу.`,
        function: votepauseCommand,
    },
    voteban: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'votes',
        desc: `
        Эта команда начинает голосование ВСЕЙ комнаты за временный бан игрока (60 минут).
    Голосовать могут только игроки, сыгравшие от 10 игр — это же требование и для того, кто начинает голосование.
    Игроков из топ-3 по любой из категорий !tops (games, wins, goals, assists, cs, playtime) забанить голосованием нельзя.
    Для бана нужно набрать 61% голосов "за" ОТ ВСЕХ, кто мог голосовать (не только от проголосовавших — те, кто не написал ничего, фактически голосуют "против").
    Она принимает 1 аргумент:
    Аргумент 1: #<id> — ID игрока, за бан которого начинается голосование.
    Игроки голосуют, написав в чат "1" (за) или "2" (против), в течение 60 секунд.
    Пример: !voteban #5 начнет голосование за бан игрока с ID 5.`,
        function: votebanCommand,
    },
    report: {
        aliases: ['админ'],
        roles: Role.PLAYER,
        category: 'misc',
        desc: `
        Эта команда зовет администрацию в комнату — объявление увидят все, а в Discord придет пинг @here в специальном канале.
    Доступна раз в минуту (на игрока).
    Пример: !report позовет администрацию.`,
        function: reportCommand,
    },
    minigames: {
        aliases: ['mg', 'мини'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        Эта команда вызывает другого зрителя на мини-игру на ставку монет. Доступно только зрителям (не участвующим в матче).
    Она принимает до 3 аргументов:
    Аргумент 1: <игра> где <игра> одна из: coinflip/cf (монетка), russianroulette/rr (русская рулетка), blackjack/bj (блэкджек), poker/покер (покер, ставки фиксированные: 25/50 монет).
    Аргумент 2: #<id> где <id> это id зрителя, которого вы вызываете. Обязателен для всех игр (против бота играть нельзя).
    Аргумент 3: <ставка> сколько монет поставить на кон (не нужен для poker — там фиксированные блайнды).
    Пример: !minigames coinflip #3 100 вызовет игрока с id 3 на монетку на 100 монет.
    Пример: !minigames blackjack #3 100 вызовет игрока с id 3 на блэкджек на 100 монет.
    Пример: !minigames poker #3 вызовет игрока с id 3 на покер (вы — small blind 25, он — big blind 50), только вы вдвоём.
    Пример: !minigames poker #3 open — то же самое, но открытый стол: другие зрители тоже могут подсесть командой "!play #<id любого игрока за столом>", максимум 4 места, вступают со следующей раздачи. Если ушедший на матч игрок был в игре — его ставка возвращается, банк уменьшается.
    Приглашенный игрок должен ввести "!play", чтобы принять вызов. "!table" покажет состав стола, "!leavetable" — встать из-за него.`,
        function: minigamesCommand,
    },
    play: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        Эта команда принимает вызов на мини-игру, полученный командой "!minigames".
    Также, "!play #<id>" (где id — любой игрок, УЖЕ сидящий за открытым покерным столом) подсаживает вас за этот стол со следующей раздачи, даже если вас никто не вызывал лично.`,
        function: playCommand,
    },
    hit: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре блэкджек (!minigames blackjack/bj) берет еще одну карту.`,
        function: hitCommand,
    },
    stand: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре блэкджек (!minigames blackjack/bj) останавливается с текущей рукой.`,
        function: standCommand,
    },
    // The old spectator match-betting feature (odds on red/blue before a
    // match) is disabled and not registered here — see core/betting.js.
    // "!bet" below is unrelated: it's poker's betting action.
    bet: {
        aliases: [],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре покер (!minigames poker/покер) ставит монеты в этом раунде торгов.
    Она принимает 1 аргумент:
    Аргумент 1: <ставка> сколько монет поставить (не больше того, что может позволить себе кто-либо ещё за столом).
    Пример: !bet 50 поставит 50 монет.`,
        function: betCommand,
    },
    call: {
        aliases: ['колл'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре покер (!minigames poker/покер) уравнивает текущую ставку за столом.`,
        function: callCommand,
    },
    check: {
        aliases: ['чек'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре покер (!minigames poker/покер) пропускает ход без ставки (доступно только если никто ещё не ставил в этом раунде).`,
        function: checkCommand,
    },
    pass: {
        aliases: ['фолд', 'fold'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        В активной игре покер (!minigames poker/покер) сбрасывает карты и выходит из текущей раздачи.`,
        function: passCommand,
    },
    leavetable: {
        aliases: ['встать'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        Встаёт из-за покерного стола, оставаясь зрителем — в отличие от "!pass", убирает вас со стола насовсем, а не только из текущей раздачи.
    Если вы были в раздаче — ваша ставка в ней возвращается.`,
        function: leaveTableCommand,
    },
    table: {
        aliases: ['стол'],
        roles: Role.PLAYER,
        category: 'minigames',
        desc: `
        Показывает, кто сидит за покерным столом (и кто подсядет со следующей раздачи).
    Без аргумента — ваш собственный стол. С аргументом #<id> — стол, за которым сидит игрок с этим id (удобно перед "!play #<id>").`,
        function: tablePlayersCommand,
    },

    };
};
