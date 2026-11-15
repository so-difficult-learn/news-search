/**
 * 웹 앱 접속 시 index.html을 화면에 렌더링합니다.
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('뉴스쏙쏙 - 초등학생 맞춤형 AI 기후·시사 학습')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Gemini API 호출 헬퍼 함수 (503 일시적 과부하 시 보조 모델로 자동 재시도)
 */
function callGeminiWithFallback(geminiApiKey, payloadObj) {
  const models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
  let lastError = '';

  for (let i = 0; i < models.length; i++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent?key=${geminiApiKey}`;
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payloadObj),
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();

    if (code === 200) {
      return JSON.parse(res.getContentText());
    }
    lastError = res.getContentText();
    if (code === 503 || code === 429) {
      Utilities.sleep(1000);
      continue;
    } else {
      break;
    }
  }
  throw new Error("Gemini AI 응답 실패: " + lastError);
}

/**
 * 클라이언트(index.html)에서 호출하는 메인 함수
 * - NAVER API HUB (https://naverapihub.apigw.ntruss.com/search/v1/news) 기사 6개 수집
 * - 기본 학년 세팅: 초등학생('elementary')
 */
function searchAndSummarizeNews(keyword, gradeLevel) {
  if (!keyword || keyword.trim() === "") {
    throw new Error("검색어를 입력해 주세요.");
  }

  const props = PropertiesService.getScriptProperties();
  const naverClientId = (props.getProperty('NAVER_CLIENT_ID') || '').trim();
  const naverClientSecret = (props.getProperty('NAVER_CLIENT_SECRET') || '').trim();
  const geminiApiKey = (props.getProperty('GEMINI_API_KEY') || '').trim();

  if (!naverClientId || !naverClientSecret || !geminiApiKey) {
    throw new Error("서버에 API 키가 설정되지 않았습니다. 프로젝트 설정 > 스크립트 속성을 확인해 주세요.");
  }

  // 1단계: NAVER API HUB 뉴스 검색 API 호출 (기사 6건 수집: display=6)
  const naverUrl = `https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(keyword.trim())}&display=6&sort=sim`;
  const naverOptions = {
    method: 'get',
    headers: {
      'X-NCP-APIGW-API-KEY-ID': naverClientId,
      'X-NCP-APIGW-API-KEY': naverClientSecret
    },
    muteHttpExceptions: true
  };

  const naverResponse = UrlFetchApp.fetch(naverUrl, naverOptions);
  if (naverResponse.getResponseCode() !== 200) {
    throw new Error("NAVER API HUB 뉴스 검색 호출 실패: " + naverResponse.getContentText());
  }

  const naverData = JSON.parse(naverResponse.getContentText());
  const items = naverData.items || [];

  if (items.length === 0) {
    return [];
  }

  // HTML 태그 제거 및 원본 기사 메타데이터 정리
  const cleanedNews = items.map((item, idx) => {
    const cleanTitle = item.title.replace(/<[^>]*>?/gm, '').replace(/"/g, '"').replace(/&/g, '&');
    const cleanDesc = item.description.replace(/<[^>]*>?/gm, '').replace(/"/g, '"').replace(/&/g, '&');
    const url = item.originallink || item.link;
    let domain = "언론사 원문";
    try {
      const match = url.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);
      if (match) domain = match[1].replace('www.', '');
    } catch (e) {}

    return {
      index: idx + 1,
      originalTitle: cleanTitle,
      snippet: cleanDesc,
      sourceUrl: url,
      sourceDomain: domain,
      pubDate: item.pubDate
    };
  });

  // 2단계: Gemini API를 호출하여 학생 눈높이 맞춤형 학습 콘텐츠로 변환 (기본값: 초등학생)
  const gradeGuide = {
    'elementary': '초등학교 4~6학년 학생이 이해하기 쉽게 아주 쉬운 어휘와 짧은 문장(친절한 해요체)으로',
    'middle': '중학교 학생 수준에 맞춰 핵심 개념과 인과관계가 잘 드러나도록(합니다/해요체)',
    'high': '고등학교 학생 수준에 맞춰 시사적 맥락과 심화 어휘를 포함해 논리적으로'
  }[gradeLevel || 'elementary'] || '초등학교 4~6학년 학생이 이해하기 쉽게 아주 쉬운 어휘와 짧은 문장(친절한 해요체)으로';

  const prompt = `당신은 한국의 초·중·고 학생들을 가르치는 친절한 문해력·시사·환경 교육 전문가입니다.
아래 제공된 실제 뉴스 검색 결과(${cleanedNews.length}건)를 바탕으로, 각각을 ${gradeGuide} 재구성해 주세요.
반드시 아래의 JSON 배열 형식으로만 응답하고, 마크다운(\`\`\`json 등)이나 부가 설명은 절대 포함하지 마세요.

[입력 뉴스 목록]
${JSON.stringify(cleanedNews, null, 2)}

[출력 JSON 스키마]
[
  {
    "id": "news_1",
    "category": "환경 | 과학/IT | 사회 | 경제 | 국제 중 택1",
    "sourceName": "원문 URL 도메인이나 기사 내용을 통해 파악한 언론사명 (예: 연합뉴스, KBS 등)",
    "originalTitle": "입력받은 원문 제목 그대로",
    "sourceUrl": "입력받은 sourceUrl 그대로",
    "pubDate": "입력받은 날짜를 한국어 날짜 형식으로 변환 (예: 2026년 11월 14일)",
    "studentTitle": "학생의 호기심을 끄는 쉬운 제목",
    "keyPoints": [
      "핵심 요약 1",
      "핵심 요약 2",
      "핵심 요약 3"
    ],
    "easyBody": "학생 눈높이로 재작성한 2~3문단의 쉬운 본문 (문단 구분은 \\n\\n 사용)",
    "vocabulary": [
      { "word": "본문에 나온 어려운 단어1", "meaning": "학생 눈높이 쉬운 뜻풀이" },
      { "word": "본문에 나온 어려운 단어2", "meaning": "학생 눈높이 쉬운 뜻풀이" }
    ],
    "quiz": {
      "question": "기사를 제대로 이해했는지 확인하는 4지선다 문제",
      "options": ["보기1", "보기2", "보기3", "보기4"],
      "answerIndex": 0,
      "explanation": "정답인 이유에 대한 친절한 해설"
    },
    "discussionTopic": "학생들이 친구들과 이야기해 볼 수 있는 생각 열기 토론 질문 1개"
  }
]`;

  const geminiJson = callGeminiWithFallback(geminiApiKey, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json"
    }
  });

  const rawText = geminiJson.candidates[0].content.parts[0].text;
  return JSON.parse(rawText);
}
