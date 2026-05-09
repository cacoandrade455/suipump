// i18n.js — SuiPump translations
// Languages: EN, ZH (Chinese), PT (Brazilian Portuguese), KO (Korean), VI (Vietnamese), RU (Russian)

export const LANGUAGES = [
  { code: 'en', label: 'EN', flag: '🇺🇸' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'pt', label: 'PT', flag: '🇧🇷' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'vi', label: 'VI', flag: '🇻🇳' },
  { code: 'ru', label: 'РУС', flag: '🇷🇺' },
];

export const translations = {
  en: {
    // Header
    testnet: 'TESTNET',
    live: 'LIVE',
    s1Airdrop: 'S1 AIRDROP',
    stats: 'STATS',
    leaderboard: 'LEADERBOARD',
    portfolio: 'PORTFOLIO',
    whitepaper: 'WHITEPAPER',
    roadmap: 'ROADMAP',
    launchToken: 'LAUNCH TOKEN',
    launch: 'LAUNCH',
    connect: 'CONNECT',
    disconnect: 'DISCONNECT',
    wallet: 'WALLET',

    // Hero
    heroTagline: 'Permissionless token launchpad on Sui.',
    heroSub: 'Fair launch · No pre-mine · 40% creator fees · Graduates to Cetus',
    launchAToken: 'LAUNCH A TOKEN',
    connectWalletToLaunch: 'CONNECT WALLET TO LAUNCH',

    // Stats bar
    tokens: 'TOKENS',
    trades: 'TRADES',
    volume: 'VOLUME',
    s1Pool: 'S1 POOL',

    // Sort
    newest: 'NEWEST',
    oldest: 'OLDEST',
    trending: '🔥 TRENDING',
    lastTrade: 'LAST TRADE',
    marketCap: 'MARKET CAP',
    volumeSort: 'VOLUME',
    tradesSort: 'TRADES',
    reserve: 'RESERVE',
    progress: 'PROGRESS',

    // Search
    searchPlaceholder: 'Search name, symbol, or 0x address…',

    // Token grid
    loadingTokens: 'LOADING TOKENS…',
    tokensLaunched: 'TOKENS LAUNCHED',
    tokensFound: 'TOKENS FOUND',
    noTokensYet: 'NO TOKENS YET',
    beFirstToLaunch: 'Be the first to launch a token on SuiPump.',
    failedToLoad: 'Failed to load tokens:',
    sortedByLastTrade: 'sorted by most recent trade activity',
    marketCapFormula: 'market cap = latest price × 1B supply',

    // Token card
    bondingCurve: 'BONDING CURVE',
    hot: 'HOT',
    grad: 'GRAD',
    communityCrown: 'COMMUNITY CROWN',

    // Footer
    footerText: 'SUIPUMP · TESTNET DEMO · CONTRACTS UNAUDITED · DYOR',
  },

  zh: {
    // Header
    testnet: '测试网',
    live: '运行中',
    s1Airdrop: 'S1空投',
    stats: '统计',
    leaderboard: '排行榜',
    portfolio: '持仓',
    whitepaper: '白皮书',
    roadmap: '路线图',
    launchToken: '发行代币',
    launch: '发行',
    connect: '连接钱包',
    disconnect: '断开连接',
    wallet: '钱包',

    // Hero
    heroTagline: 'Sui上的无许可代币发行平台。',
    heroSub: '公平发行 · 无预挖 · 40%创作者费用 · 毕业至Cetus',
    launchAToken: '发行代币',
    connectWalletToLaunch: '连接钱包以发行',

    // Stats bar
    tokens: '代币',
    trades: '交易',
    volume: '交易量',
    s1Pool: 'S1池',

    // Sort
    newest: '最新',
    oldest: '最旧',
    trending: '🔥 热门',
    lastTrade: '最近交易',
    marketCap: '市值',
    volumeSort: '交易量',
    tradesSort: '交易次数',
    reserve: '储备',
    progress: '进度',

    // Search
    searchPlaceholder: '搜索名称、符号或0x地址…',

    // Token grid
    loadingTokens: '加载代币中…',
    tokensLaunched: '个代币已发行',
    tokensFound: '个代币已找到',
    noTokensYet: '暂无代币',
    beFirstToLaunch: '成为第一个在SuiPump发行代币的人。',
    failedToLoad: '加载代币失败：',
    sortedByLastTrade: '按最近交易活动排序',
    marketCapFormula: '市值 = 最新价格 × 10亿供应量',

    // Token card
    bondingCurve: '联合曲线',
    hot: '热门',
    grad: '毕业',
    communityCrown: '社区王冠',

    // Footer
    footerText: 'SUIPUMP · 测试网演示 · 合约未审计 · DYOR',
  },

  pt: {
    // Header
    testnet: 'TESTNET',
    live: 'AO VIVO',
    s1Airdrop: 'AIRDROP S1',
    stats: 'STATS',
    leaderboard: 'RANKING',
    portfolio: 'PORTFÓLIO',
    whitepaper: 'WHITEPAPER',
    roadmap: 'ROADMAP',
    launchToken: 'LANÇAR TOKEN',
    launch: 'LANÇAR',
    connect: 'CONECTAR',
    disconnect: 'DESCONECTAR',
    wallet: 'CARTEIRA',

    // Hero
    heroTagline: 'Plataforma de lançamento de tokens sem permissão no Sui.',
    heroSub: 'Lançamento justo · Sem pré-mineração · 40% de taxas pros criadores · Graduação na Cetus',
    launchAToken: 'LANÇAR UM TOKEN',
    connectWalletToLaunch: 'CONECTE A CARTEIRA PARA LANÇAR',

    // Stats bar
    tokens: 'TOKENS',
    trades: 'NEGOCIAÇÕES',
    volume: 'VOLUME',
    s1Pool: 'POOL S1',

    // Sort
    newest: 'MAIS NOVO',
    oldest: 'MAIS ANTIGO',
    trending: '🔥 EM ALTA',
    lastTrade: 'ÚLTIMA NEGOCIAÇÃO',
    marketCap: 'CAP. MERCADO',
    volumeSort: 'VOLUME',
    tradesSort: 'NEGOCIAÇÕES',
    reserve: 'RESERVA',
    progress: 'PROGRESSO',

    // Search
    searchPlaceholder: 'Pesquisar nome, símbolo ou endereço 0x…',

    // Token grid
    loadingTokens: 'CARREGANDO TOKENS…',
    tokensLaunched: 'TOKENS LANÇADOS',
    tokensFound: 'TOKENS ENCONTRADOS',
    noTokensYet: 'NENHUM TOKEN AINDA',
    beFirstToLaunch: 'Seja o primeiro a lançar um token no SuiPump.',
    failedToLoad: 'Falha ao carregar tokens:',
    sortedByLastTrade: 'ordenado pela atividade de negociação mais recente',
    marketCapFormula: 'cap. mercado = preço mais recente × 1B de fornecimento',

    // Token card
    bondingCurve: 'CURVA DE LIGAÇÃO',
    hot: 'QUENTE',
    grad: 'FORMADO',
    communityCrown: 'COROA DA COMUNIDADE',

    // Footer
    footerText: 'SUIPUMP · DEMO TESTNET · CONTRATOS NÃO AUDITADOS · DYOR',
  },

  ko: {
    // Header
    testnet: '테스트넷',
    live: '라이브',
    s1Airdrop: 'S1 에어드랍',
    stats: '통계',
    leaderboard: '리더보드',
    portfolio: '포트폴리오',
    whitepaper: '백서',
    roadmap: '로드맵',
    launchToken: '토큰 출시',
    launch: '출시',
    connect: '지갑 연결',
    disconnect: '연결 해제',
    wallet: '지갑',

    // Hero
    heroTagline: 'Sui의 무허가 토큰 런치패드.',
    heroSub: '공정 출시 · 프리마이닝 없음 · 크리에이터 수수료 40% · Cetus로 졸업',
    launchAToken: '토큰 출시하기',
    connectWalletToLaunch: '출시하려면 지갑을 연결하세요',

    // Stats bar
    tokens: '토큰',
    trades: '거래',
    volume: '거래량',
    s1Pool: 'S1 풀',

    // Sort
    newest: '최신순',
    oldest: '오래된순',
    trending: '🔥 트렌딩',
    lastTrade: '최근 거래',
    marketCap: '시가총액',
    volumeSort: '거래량',
    tradesSort: '거래 수',
    reserve: '보유량',
    progress: '진행도',

    // Search
    searchPlaceholder: '이름, 심볼 또는 0x 주소 검색…',

    // Token grid
    loadingTokens: '토큰 로딩 중…',
    tokensLaunched: '개 토큰 출시됨',
    tokensFound: '개 토큰 발견됨',
    noTokensYet: '아직 토큰 없음',
    beFirstToLaunch: 'SuiPump에서 첫 번째로 토큰을 출시하세요.',
    failedToLoad: '토큰 로드 실패:',
    sortedByLastTrade: '최근 거래 활동 순으로 정렬됨',
    marketCapFormula: '시가총액 = 최신 가격 × 10억 공급량',

    // Token card
    bondingCurve: '본딩 커브',
    hot: '핫',
    grad: '졸업',
    communityCrown: '커뮤니티 왕관',

    // Footer
    footerText: 'SUIPUMP · 테스트넷 데모 · 계약 미감사 · DYOR',
  },

  vi: {
    // Header
    testnet: 'TESTNET',
    live: 'TRỰC TIẾP',
    s1Airdrop: 'AIRDROP S1',
    stats: 'THỐNG KÊ',
    leaderboard: 'BẢNG XẾP HẠNG',
    portfolio: 'DANH MỤC',
    whitepaper: 'WHITEPAPER',
    roadmap: 'LỘ TRÌNH',
    launchToken: 'PHÁT HÀNH TOKEN',
    launch: 'PHÁT HÀNH',
    connect: 'KẾT NỐI VÍ',
    disconnect: 'NGẮT KẾT NỐI',
    wallet: 'VÍ',

    // Hero
    heroTagline: 'Nền tảng phát hành token không cần cấp phép trên Sui.',
    heroSub: 'Ra mắt công bằng · Không pre-mine · 40% phí cho creator · Tốt nghiệp lên Cetus',
    launchAToken: 'PHÁT HÀNH TOKEN',
    connectWalletToLaunch: 'KẾT NỐI VÍ ĐỂ PHÁT HÀNH',

    // Stats bar
    tokens: 'TOKEN',
    trades: 'GIAO DỊCH',
    volume: 'KHỐI LƯỢNG',
    s1Pool: 'QUỸ S1',

    // Sort
    newest: 'MỚI NHẤT',
    oldest: 'CŨ NHẤT',
    trending: '🔥 XU HƯỚNG',
    lastTrade: 'GIAO DỊCH GẦN NHẤT',
    marketCap: 'VỐN HÓA',
    volumeSort: 'KHỐI LƯỢNG',
    tradesSort: 'GIAO DỊCH',
    reserve: 'DỰ TRỮ',
    progress: 'TIẾN ĐỘ',

    // Search
    searchPlaceholder: 'Tìm tên, ký hiệu hoặc địa chỉ 0x…',

    // Token grid
    loadingTokens: 'ĐANG TẢI TOKEN…',
    tokensLaunched: 'TOKEN ĐÃ PHÁT HÀNH',
    tokensFound: 'TOKEN TÌM THẤY',
    noTokensYet: 'CHƯA CÓ TOKEN',
    beFirstToLaunch: 'Hãy là người đầu tiên phát hành token trên SuiPump.',
    failedToLoad: 'Tải token thất bại:',
    sortedByLastTrade: 'sắp xếp theo hoạt động giao dịch gần nhất',
    marketCapFormula: 'vốn hóa = giá mới nhất × 1 tỷ cung',

    // Token card
    bondingCurve: 'ĐƯỜNG CONG',
    hot: 'HOT',
    grad: 'TỐT NGHIỆP',
    communityCrown: 'VƯƠNG MIỆN CỘNG ĐỒNG',

    // Footer
    footerText: 'SUIPUMP · DEMO TESTNET · HỢP ĐỒNG CHƯA KIỂM TOÁN · DYOR',
  },

  ru: {
    // Header
    testnet: 'ТЕСТНЕТ',
    live: 'В ЭФИРЕ',
    s1Airdrop: 'АИРДРОП S1',
    stats: 'СТАТИСТИКА',
    leaderboard: 'РЕЙТИНГ',
    portfolio: 'ПОРТФЕЛЬ',
    whitepaper: 'ВАЙТПЕЙПЕР',
    roadmap: 'ДОРОЖНАЯ КАРТА',
    launchToken: 'ЗАПУСТИТЬ ТОКЕН',
    launch: 'ЗАПУСК',
    connect: 'ПОДКЛЮЧИТЬ',
    disconnect: 'ОТКЛЮЧИТЬ',
    wallet: 'КОШЕЛЁК',

    // Hero
    heroTagline: 'Безразрешительная платформа запуска токенов на Sui.',
    heroSub: 'Честный запуск · Без пре-майна · 40% комиссий создателям · Выпускается на Cetus',
    launchAToken: 'ЗАПУСТИТЬ ТОКЕН',
    connectWalletToLaunch: 'ПОДКЛЮЧИТЕ КОШЕЛЁК ДЛЯ ЗАПУСКА',

    // Stats bar
    tokens: 'ТОКЕНЫ',
    trades: 'СДЕЛКИ',
    volume: 'ОБЪЁМ',
    s1Pool: 'ПУЛА S1',

    // Sort
    newest: 'НОВЫЕ',
    oldest: 'СТАРЫЕ',
    trending: '🔥 ТРЕНД',
    lastTrade: 'ПОСЛЕДНЯЯ СДЕЛКА',
    marketCap: 'КАПИТАЛИЗАЦИЯ',
    volumeSort: 'ОБЪЁМ',
    tradesSort: 'СДЕЛКИ',
    reserve: 'РЕЗЕРВ',
    progress: 'ПРОГРЕСС',

    // Search
    searchPlaceholder: 'Поиск по имени, тикеру или 0x адресу…',

    // Token grid
    loadingTokens: 'ЗАГРУЗКА ТОКЕНОВ…',
    tokensLaunched: 'ТОКЕНОВ ЗАПУЩЕНО',
    tokensFound: 'ТОКЕНОВ НАЙДЕНО',
    noTokensYet: 'ТОКЕНОВ ЕЩЁ НЕТ',
    beFirstToLaunch: 'Станьте первым, кто запустит токен на SuiPump.',
    failedToLoad: 'Ошибка загрузки токенов:',
    sortedByLastTrade: 'отсортировано по последней торговой активности',
    marketCapFormula: 'капитализация = последняя цена × 1 млрд токенов',

    // Token card
    bondingCurve: 'КРИВАЯ',
    hot: 'ХОТ',
    grad: 'ВЫПУСКНИК',
    communityCrown: 'КОРОНА СООБЩЕСТВА',

    // Footer
    footerText: 'SUIPUMP · ДЕМО ТЕСТНЕТ · КОНТРАКТЫ НЕ АУДИРОВАНЫ · DYOR',
  },
};

export function t(lang, key) {
  return translations[lang]?.[key] ?? translations['en'][key] ?? key;
}
