const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일 제공 (public 폴더)
app.use(express.static('public'));

// 카테고리별 제시어 단어장
const WORDS_DATABASE = {
  "음식": ["치킨", "피자", "삼겹살", "떡볶이", "초밥", "라면", "파스타", "햄버거", "족발", "짜장면"],
  "동물": ["호랑이", "사자", "기린", "코끼리", "강아지", "고양이", "펭귄", "팬더", "얼룩말", "토끼"],
  "직업": ["의사", "경찰", "소방관", "교사", "요리사", "비행기 조종사", "판사", "화가", "가수", "운동선수"],
  "장소": ["학교", "병원", "공항", "놀이공원", "영화관", "도서관", "은행", "해수욕장", "경찰서", "미술관"]
};

// 방 데이터 저장소
// rooms[roomCode] = { players: [{id, nickname, host}], state: 'LOBBY'|'PLAYING'|'VOTING'|'GUESSING', liar: socketId, topic: '', word: '', votes: {}, liarGuessing: false }
const rooms = {};

// 6자리 방 코드 생성 함수
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

io.on('connection', (socket) => {
  console.log(`유저 연결됨: ${socket.id}`);

  // 1. 방 생성
  socket.on('createRoom', ({ nickname }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    socket.join(roomCode);
    rooms[roomCode] = {
      code: roomCode,
      state: 'LOBBY',
      players: [{ id: socket.id, nickname: nickname, host: true }],
      topic: '',
      word: '',
      liarId: null,
      votes: {},
      mostVotedId: null
    };

    socket.emit('roomCreated', { roomCode, players: rooms[roomCode].players });
  });

  // 2. 방 참가
  socket.on('joinRoom', ({ nickname, roomCode }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit('errorMessage', '존재하지 않는 방 코드입니다.');
      return;
    }

    if (room.state !== 'LOBBY') {
      socket.emit('errorMessage', '이미 게임이 진행 중인 방입니다.');
      return;
    }

    socket.join(code);
    room.players.push({ id: socket.id, nickname: nickname, host: false });

    // 방 안의 모든 인원에게 갱신된 플레이어 목록 전송
    io.to(code).emit('updatePlayers', { roomCode: code, players: room.players });
  });

  // 3. 게임 시작 (방장 전용)
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players[0].id !== socket.id) {
      socket.emit('errorMessage', '방장만 게임을 시작할 수 있습니다.');
      return;
    }

    if (room.players.length < 3) {
      socket.emit('errorMessage', '최소 3명 이상의 플레이어가 필요합니다.');
      return;
    }

    // 카테고리 및 단어 랜덤 선정
    const categories = Object.keys(WORDS_DATABASE);
    const randomCategory = categories[Math.floor(Math.random() * categories.length)];
    const wordList = WORDS_DATABASE[randomCategory];
    const randomWord = wordList[Math.floor(Math.random() * wordList.length)];

    // 라이어 랜덤 선정
    const liarIndex = Math.floor(Math.random() * room.players.length);
    const liarId = room.players[liarIndex].id;

    room.state = 'PLAYING';
    room.topic = randomCategory;
    room.word = randomWord;
    room.liarId = liarId;
    room.votes = {};

    // 소켓별로 역할 및 제시어 부여
    room.players.forEach((player) => {
      const isLiar = player.id === liarId;
      io.to(player.id).emit('gameStarted', {
        topic: randomCategory,
        word: isLiar ? ' 당신은 라이어입니다! 🤫' : randomWord,
        isLiar: isLiar,
        players: room.players
      });
    });
  });

  // 4. 투표 시작 (누군가가 투표 버튼을 누름)
  socket.on('startVote', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'PLAYING') return;

    room.state = 'VOTING';
    room.votes = {};

    io.to(roomCode).emit('voteStarted', { players: room.players });
  });

  // 5. 투표 제출
  socket.on('submitVote', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'VOTING') return;

    room.votes[socket.id] = targetId;

    // 모든 인원이 투표를 완료했는지 확인
    if (Object.keys(room.votes).length === room.players.length) {
      // 득표 수 집계
      const voteCounts = {};
      Object.values(room.votes).forEach((tId) => {
        voteCounts[tId] = (voteCounts[tId] || 0) + 1;
      });

      // 최다 득표자 찾기
      let maxVotes = 0;
      let mostVotedId = null;
      let isTie = false;

      for (const [pId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          mostVotedId = pId;
          isTie = false;
        } else if (count === maxVotes) {
          isTie = true; // 동점 발생
        }
      }

      const liarPlayer = room.players.find(p => p.id === room.liarId);
      const votedPlayer = room.players.find(p => p.id === mostVotedId);

      if (isTie || !mostVotedId) {
        // 동점인 경우 시민 승리/재투표 처리 (여기선 라이어 승리로 처리)
        io.to(roomCode).emit('gameResult', {
          winner: 'LIAR',
          reason: `투표가 동점입니다! 라이어 [${liarPlayer.nickname}]의 승리입니다!`,
          word: room.word
        });
        room.state = 'LOBBY';
      } else if (mostVotedId === room.liarId) {
        // 라이어를 지목한 경우 -> 라이어에게 제시어 맞출 기회 제공
        room.state = 'GUESSING';
        room.mostVotedId = mostVotedId;
        io.to(roomCode).emit('liarCaught', {
          liarId: room.liarId,
          liarNickname: liarPlayer.nickname
        });
      } else {
        // 억울한 시민을 지목한 경우 -> 라이어 승리
        io.to(roomCode).emit('gameResult', {
          winner: 'LIAR',
          reason: `지목된 [${votedPlayer.nickname}]님은 시민이었습니다! 라이어 [${liarPlayer.nickname}]의 승리!`,
          word: room.word
        });
        room.state = 'LOBBY';
      }
    }
  });

  // 6. 지목당한 라이어의 최종 정답 도전
  socket.on('guessWord', ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'GUESSING') return;
    if (socket.id !== room.liarId) return;

    const liarPlayer = room.players.find(p => p.id === room.liarId);
    const isCorrect = guess.trim() === room.word.trim();

    if (isCorrect) {
      io.to(roomCode).emit('gameResult', {
        winner: 'LIAR',
        reason: `라이어 [${liarPlayer.nickname}]님이 제시어 [${room.word}]를 맞추었습니다! 라이어 승리!`,
        word: room.word
      });
    } else {
      io.to(roomCode).emit('gameResult', {
        winner: 'CITIZEN',
        reason: `라이어 [${liarPlayer.nickname}]님이 정답 맞추기에 실패했습니다! (입력: ${guess}) 시민 승리!`,
        word: room.word
      });
    }
    room.state = 'LOBBY';
  });

  // 7. 연결 해제 처리
  socket.on('disconnect', () => {
    console.log(`유저 연결 끊김: ${socket.id}`);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const index = room.players.findIndex(p => p.id === socket.id);

      if (index !== -1) {
        const removedPlayer = room.players.splice(index, 1)[0];

        // 방에 아무도 없으면 방 삭제
        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          // 방장이 나갔다면 방장 위임
          if (removedPlayer.host) {
            room.players[0].host = true;
          }
          io.to(roomCode).emit('updatePlayers', { roomCode, players: room.players });
        }
        break;
      }
    }
  });
});

// 포트 설정 (Render 환경변수 PORT 자동 할당 지원)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
