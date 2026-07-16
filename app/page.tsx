// app/page.tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

const BOARD_SIZE = 15;
type Player = 1 | 2; // 1: 흑(나/유저), 2: 백(상대/AI)
type Board = (Player | null)[][];

export default function Home() {
  const [board, setBoard] = useState<Board>(
    Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null))
  );
  const [turn, setTurn] = useState<Player>(1);
  const [myColor, setMyColor] = useState<Player | null>(null);
  const [gameMode, setGameMode] = useState<'AI' | 'MULTIPLAYER' | null>(null);
  const [roomId, setRoomId] = useState<string>('');
  const [winner, setWinner] = useState<Player | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('모드를 선택하세요.');

  const channelRef = useRef<RealtimeChannel | null>(null);

  // --- 1. 승리 판정 (5목 연속 체크) ---
  const checkWin = (r: number, c: number, player: Player, currentBoard: Board): boolean => {
    const directions = [
      [0, 1],   // 가로
      [1, 0],   // 세로
      [1, 1],   // 우하 대각선
      [1, -1],  // 좌하 대각선
    ];

    for (const [dr, dc] of directions) {
      let count = 1;

      // 정방향
      let nr = r + dr;
      let nc = c + dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
        count++;
        nr += dr;
        nc += dc;
      }

      // 역방향
      nr = r - dr;
      nc = c - dc;
      while (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
        count++;
        nr -= dr;
        nc -= dc;
      }

      if (count === 5) return true; // 정확히 5개면 승리
    }
    return false;
  };

  // --- 2. AI 로직 (가중치 기반 수비 & 공격) ---
  const makeAIMove = (currentBoard: Board) => {
    let bestScore = -1;
    let bestMove = { r: -1, c: -1 };

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (currentBoard[r][c] !== null) continue;

        let score = 0;
        const directions = [[0,1], [1,0], [1,1], [1,-1]];
        
        for (const [dr, dc] of directions) {
          const aiCount = countConsecutive(r, c, dr, dc, 2, currentBoard);
          const userCount = countConsecutive(r, c, dr, dc, 1, currentBoard);

          // AI 공격 점수 부여
          if (aiCount === 4) score += 100000;
          else if (aiCount === 3) score += 1000;
          else if (aiCount === 2) score += 100;

          // 유저 방어 점수 부여
          if (userCount === 4) score += 50000;
          else if (userCount === 3) score += 800;
          else if (userCount === 2) score += 50;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMove = { r, c };
        }
      }
    }

    if (bestMove.r !== -1 && bestMove.c !== -1) {
      const newBoard = currentBoard.map(row => [...row]);
      newBoard[bestMove.r][bestMove.c] = 2; // AI는 백돌(2)
      setBoard(newBoard);

      if (checkWin(bestMove.r, bestMove.c, 2, newBoard)) {
        setWinner(2);
        setStatusMessage('AI가 승리했습니다! 🤖');
      } else {
        setTurn(1);
        setStatusMessage('당신의 차례입니다 (흑)');
      }
    }
  };

  const countConsecutive = (r: number, c: number, dr: number, dc: number, player: Player, currentBoard: Board) => {
    let count = 0;
    for (let i = 1; i <= 4; i++) {
      const nr = r + dr * i;
      const nc = c + dc * i;
      if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
        count++;
      } else break;
    }
    for (let i = 1; i <= 4; i++) {
      const nr = r - dr * i;
      const nc = c - dc * i;
      if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && currentBoard[nr][nc] === player) {
        count++;
      } else break;
    }
    return count;
  };

  // --- 3. Supabase 실시간 멀티플레이 통신 ---
  const joinRoom = () => {
    if (!roomId.trim()) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);

    // Supabase 실시간 브로드캐스트 채널 생성
    const channel = supabase.channel(`room:${roomId}`, {
      config: { broadcast: { self: true } } // 내가 보낸 움직임도 나에게 수신되도록 설정
    });

    channel
      .on('broadcast', { event: 'move' }, ({ payload }) => {
        const { r, c, player } = payload;
        
        setBoard((prev) => {
          const newBoard = prev.map(row => [...row]);
          newBoard[r][c] = player;

          if (checkWin(r, c, player, newBoard)) {
            setWinner(player);
            setStatusMessage(player === 1 ? '흑돌 승리! 🎉' : '백돌 승리! 🎉');
          } else {
            setTurn(player === 1 ? 2 : 1);
          }
          return newBoard;
        });
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const users = Object.keys(state);
        
        // 방에 먼저 오면 흑돌(1), 두 번째로 오면 백돌(2)
        if (users.length === 1) {
          setMyColor(1);
          setStatusMessage('상대방의 입장을 기다리고 있습니다... (내 색상: 흑)');
        } else if (users.length === 2 && !myColor) {
          setMyColor(2);
          setStatusMessage('게임이 시작되었습니다! (내 색상: 백)');
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // 입장자 추적 시작
          await channel.track({ user_id: Math.random().toString(36).substring(7) });
        }
      });

    channelRef.current = channel;
    setGameMode('MULTIPLAYER');
    resetGame();
  };

  // --- 4. 돌 놓기 동작 ---
  const handleCellClick = (r: number, c: number) => {
    if (board[r][c] !== null || winner) return;

    if (gameMode === 'AI') {
      if (turn !== 1) return; // AI 모드에서 유저는 무조건 흑돌(1)
      
      const newBoard = board.map(row => [...row]);
      newBoard[r][c] = 1;
      setBoard(newBoard);

      if (checkWin(r, c, 1, newBoard)) {
        setWinner(1);
        setStatusMessage('축하합니다! 당신이 승리했습니다! 🎉');
      } else {
        setTurn(2);
        setStatusMessage('AI가 다음 수를 계산 중입니다...');
        setTimeout(() => makeAIMove(newBoard), 600); // 더 자연스러운 대전을 위해 0.6초 딜레이
      }
    } else if (gameMode === 'MULTIPLAYER') {
      if (turn !== myColor) {
        alert('당신의 차례가 아닙니다!');
        return;
      }
      
      // Supabase 채널을 통해 상대 유저에게 정보 전송
      if (channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'move',
          payload: { r, c, player: myColor }
        });
      }
    }
  };

  const resetGame = () => {
    setBoard(Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null)));
    setTurn(1);
    setWinner(null);
    if (gameMode === 'AI') setStatusMessage('당신의 차례입니다 (흑)');
  };

  useEffect(() => {
    if (gameMode === 'MULTIPLAYER' && !winner) {
      setStatusMessage(turn === myColor ? '★ 당신의 차례입니다! ★' : '상대방이 생각하는 중입니다...');
    }
  }, [turn, myColor, gameMode, winner]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-100 p-4 text-slate-800">
      <h1 className="text-3xl font-bold mb-6">오목 Game (AI & 실시간)</h1>
      
      {!gameMode ? (
        <div className="flex flex-col gap-4 bg-white p-6 rounded-lg shadow-md w-80">
          <button 
            onClick={() => { setGameMode('AI'); setStatusMessage('당신의 차례입니다 (흑)'); }} 
            className="bg-blue-500 text-white py-2.5 rounded font-semibold hover:bg-blue-600 transition"
          >
            싱글 AI 대전 시작
          </button>
          <hr className="my-2 border-slate-200" />
          <input 
            type="text" 
            placeholder="입장할 방 ID 입력 (예: room123)" 
            value={roomId} 
            onChange={(e) => setRoomId(e.target.value)} 
            className="border p-2 rounded focus:outline-blue-500" 
          />
          <button 
            onClick={joinRoom} 
            className="bg-emerald-500 text-white py-2.5 rounded font-semibold hover:bg-emerald-600 transition"
          >
            멀티플레이 방 입장/생성
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <p className="text-lg font-semibold mb-4 text-slate-700">{statusMessage}</p>

          {/* 나무판 느낌의 오목판 배경 */}
          <div className="bg-[#DCB35C] p-3 rounded-lg shadow-xl border-4 border-amber-950">
            <div className="grid grid-cols-[repeat(15,minmax(0,1fr))] bg-[#DCB35C]">
              {board.map((row, r) =>
                row.map((cell, c) => (
                  <button 
                    key={`${r}-${c}`} 
                    onClick={() => handleCellClick(r, c)} 
                    disabled={!!winner} 
                    className="relative w-8 h-8 md:w-10 md:h-10 flex items-center justify-center hover:bg-amber-600/30 transition focus:outline-none"
                  >
                    {/* 격자선 교차점 표현 */}
                    <div className="absolute w-full h-[1px] bg-amber-950/40 top-1/2 left-0" />
                    <div className="absolute h-full w-[1px] bg-amber-950/40 left-1/2 top-0" />
                    
                    {/* 화점(점) 표시 */}
                    {((r === 3 || r === 7 || r === 11) && (c === 3 || c === 7 || c === 11)) && (
                      <div className="absolute w-1.5 h-1.5 bg-amber-950 rounded-full z-0" />
                    )}

                    {/* 돌 이미지(CSS) */}
                    {cell === 1 && <div className="w-6 h-6 md:w-8 md:h-8 rounded-full bg-zinc-950 shadow-md z-10 animate-scale-up" />}
                    {cell === 2 && <div className="w-6 h-6 md:w-8 md:h-8 rounded-full bg-slate-50 border border-slate-300 shadow-md z-10 animate-scale-up" />}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="mt-6 flex gap-4">
            <button onClick={resetGame} className="px-5 py-2 bg-slate-500 text-white rounded hover:bg-slate-600 transition font-medium">재시작</button>
            <button 
              onClick={() => { 
                if (channelRef.current) supabase.removeChannel(channelRef.current); 
                setGameMode(null); 
                setMyColor(null);
                resetGame();
              }} 
              className="px-5 py-2 bg-rose-500 text-white rounded hover:bg-rose-600 transition font-medium"
            >
              메인으로
            </button>
          </div>
        </div>
      )}
    </div>
  );
}