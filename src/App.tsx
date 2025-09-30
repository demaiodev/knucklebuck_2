import "./index.css";

import React, { useState, useEffect, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  collection,
  onSnapshot,
  writeBatch,
  Firestore,
} from "firebase/firestore";

// --- 1. TYPES AND CONSTANTS ---

// Define the shape of the game data
interface Player {
  name: string;
  isFirstPlayer: boolean;
  currentRoll: number;
  score: number;
  currency: number;
  wager: number;
  board: number[][]; // 3x3 array of dice values (0-6)
  wins: number;
  isActive: boolean;
  // Add an ID for Firestore doc reference later
  id: string;
}

interface GameState {
  winner?: Player;
  gameOver: boolean;
  difficulty: number; // 0: Normal, 1: Easy, 2: Hard
  rollingDice: boolean;
  isAuthReady: boolean;
}

const TOTAL_LANES = 3;
const LANE_SIZE = 3;

// Updated the order to Easy, Normal, Hard (values remain the same)
const DIFFICULTY_LEVELS = [
  { value: 1, label: "Easy" },
  { value: 0, label: "Normal" },
  { value: 2, label: "Hard" },
];

// --- 2. GAME UTILITIES (Pure Functions) ---

/**
 * Calculates the score for a single lane based on dice values.
 * Score = sum(value * count * count) for each unique value.
 */
function calcLaneScore(lane: number[]): number {
  const dict: { [key: number]: number } = {};
  let score = 0;

  // Count occurrences of each die value (1-6)
  for (const value of lane) {
    if (value !== 0) {
      dict[value] = (dict[value] || 0) + 1;
    }
  }

  // Calculate score
  for (const property in dict) {
    const value = parseInt(property);
    const count = dict[property];
    score += value * count * count;
  }
  return score;
}

/**
 * Calculates the total score for a player's board.
 */
function calcTotalScore(board: number[][]): number {
  let totalScore = 0;
  for (let i = 0; i < TOTAL_LANES; i++) {
    totalScore += calcLaneScore(board[i]);
  }
  return totalScore;
}

/**
 * Returns a new board lane with matching dice cleared (replaced by 0s at the end).
 * This ensures array immutability for React state updates.
 */
function clearMatches(lane: number[], valueToClear: number): number[] {
  const newLane = lane.filter((v) => v !== valueToClear);
  // Pad the new lane with 0s to maintain original length
  while (newLane.length < LANE_SIZE) {
    newLane.push(0);
  }
  return newLane;
}

// --- 3. KNUCKLEBOT AI LOGIC ---

const selectRandomSpace = () => Math.floor(Math.random() * TOTAL_LANES);

const laneIsFull = (board: number[][], laneIndex: number) => {
  // Check the last slot in the lane (index 2 for a 3-slot lane)
  return board[laneIndex][LANE_SIZE - 1] !== 0;
};

// Finds an index of a non-full lane where the roll matches an existing die
const matchMove = (selfBoard: number[][], roll: number) => {
  for (let x = 0; x < selfBoard.length; x++) {
    // Only consider non-full lanes for a matching move
    if (selfBoard[x].includes(roll) && !laneIsFull(selfBoard, x)) return x;
  }
  return -1;
};

// Finds the index of an opponent's lane where the roll can be captured
const captureMove = (opponentBoard: number[][], roll: number) => {
  for (let x = 0; x < opponentBoard.length; x++) {
    if (opponentBoard[x].includes(roll)) return x;
  }
  return -1;
};

// Finds the best non-full lane to maximize current score
const bestPlacementMove = (selfBoard: number[][], roll: number): number => {
  let bestLaneIndex = -1;
  let maxScoreIncrease = -Infinity;

  for (let i = 0; i < selfBoard.length; i++) {
    if (!laneIsFull(selfBoard, i)) {
      // Simulate placing the die
      const currentLane = selfBoard[i];
      const nextEmptyIndex = currentLane.findIndex((v) => v === 0);

      // This is complex, so let's use a simpler heuristic for 'Hard':
      // Prioritize empty lanes, or lanes with the most dice already in them.

      const filledSlots = currentLane.filter((v) => v !== 0).length;

      if (filledSlots < LANE_SIZE) {
        // For simplicity, hard mode just targets the least filled lane that also has the roll,
        // or just the least filled lane if no match is available.
        const nextLane: number[] = [...currentLane];
        nextLane[nextEmptyIndex] = roll;
        const newScore = calcLaneScore(nextLane);
        const currentScore = calcLaneScore(currentLane);
        const scoreIncrease = newScore - currentScore;

        if (scoreIncrease > maxScoreIncrease) {
          maxScoreIncrease = scoreIncrease;
          bestLaneIndex = i;
        }
      }
    }
  }
  // If a good scoring move is found, use it, otherwise fall back to the first non-full lane.
  if (bestLaneIndex !== -1) return bestLaneIndex;

  // Fallback: find the first non-full lane
  for (let i = 0; i < selfBoard.length; i++) {
    if (!laneIsFull(selfBoard, i)) return i;
  }
  return selectRandomSpace(); // Should only happen if all lanes are full
};

/**
 * Knucklebot AI logic based on difficulty.
 */
function knucklebotMove(
  opponentBoard: number[][],
  selfBoard: number[][],
  roll: number,
  difficulty: number,
  isGameOver: boolean
): number {
  // If the game is over, always return a random space (it shouldn't execute, but as a safeguard)
  if (isGameOver) return selectRandomSpace();

  const captureIndex = captureMove(opponentBoard, roll);
  const matchIndex = matchMove(selfBoard, roll);
  const firstNonFullLane = selfBoard.findIndex(
    (_, i) => !laneIsFull(selfBoard, i)
  );

  // Default fallback to random space
  let selectedIndex = selectRandomSpace();
  while (laneIsFull(selfBoard, selectedIndex)) {
    selectedIndex = selectRandomSpace();
  }

  switch (difficulty) {
    case 1: // Easy: Prioritize Match > Capture > Random
      if (matchIndex !== -1) return matchIndex;
      if (captureIndex !== -1 && !laneIsFull(selfBoard, captureIndex))
        return captureIndex;
      return firstNonFullLane !== -1 ? firstNonFullLane : selectedIndex;

    case 2: {
      // Hard: Prioritize Capture > Best Placement (Score Max) > Match > Random
      if (captureIndex !== -1 && !laneIsFull(selfBoard, captureIndex))
        return captureIndex;

      // Aggressive Placement: Try to find a move that yields the highest *immediate* score increase
      const bestIndex = bestPlacementMove(selfBoard, roll);
      if (bestIndex !== -1) return bestIndex;

      if (matchIndex !== -1) return matchIndex;
      return firstNonFullLane !== -1 ? firstNonFullLane : selectedIndex;
    }

    case 0: // Normal (Default): Prioritize Capture > Match > Random
    default:
      if (captureIndex !== -1 && !laneIsFull(selfBoard, captureIndex))
        return captureIndex;
      if (matchIndex !== -1) return matchIndex;
      return firstNonFullLane !== -1 ? firstNonFullLane : selectedIndex;
  }
}

// --- 4. FIREBASE CONFIGURATION AND AUTH ---

// Global variables provided by the Canvas environment
declare const __app_id: string;
declare const __firebase_config: string;
declare const __initial_auth_token: string;

// IMPORTANT: For local development, replace the placeholder values below with
// your own Firebase project's web configuration object.
// When running in the Canvas environment, this object will be ignored.
const LOCAL_FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  // measurementId: "G-XXXXXXXXXX" // Optional
};

const appId =
  typeof __app_id !== "undefined" ? __app_id : "knucklebuck-default";

// Prioritize Canvas config, fall back to the user's local config if running outside Canvas.
const firebaseConfig =
  typeof __firebase_config !== "undefined"
    ? JSON.parse(__firebase_config)
    : LOCAL_FIREBASE_CONFIG; // Use hardcoded local config as fallback

// Interface to type-check for Firebase errors
interface FirebaseError {
  code: string;
  message: string;
}

/**
 * Helper to handle exponential backoff for Firestore retries.
 */
async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: unknown) {
      // Check if the error object resembles a FirebaseError with a 'code' property
      const isFirebaseError =
        typeof error === "object" && error !== null && "code" in error;

      if (isFirebaseError) {
        // Now TypeScript knows this object has a 'code' property
        const firebaseError = error as FirebaseError;

        // Check for retryable error codes
        if (
          firebaseError.code === "unavailable" ||
          firebaseError.code === "resource-exhausted" ||
          firebaseError.message.includes("unavailable")
        ) {
          const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Continue to the next retry attempt
        }
      }

      // If it's not a retryable error, or if we can't determine the type, throw
      console.error("Firebase operation failed after retries:", error);
      throw error;
    }
  }
  throw new Error("Max retries exceeded for Firebase operation.");
}

// --- 5. REACT COMPONENTS ---

/**
 * Renders a standard dice face using SVG dots.
 */
const DiceFace: React.FC<{ value: number }> = React.memo(({ value }) => {
  // Dot positions (relative to a 100x100 grid)
  const dotPositions: { [key: number]: [number, number][] } = {
    1: [[50, 50]],
    2: [
      [25, 25],
      [75, 75],
    ],
    3: [
      [25, 25],
      [50, 50],
      [75, 75],
    ],
    4: [
      [25, 25],
      [75, 75],
      [25, 75],
      [75, 25],
    ],
    5: [
      [25, 25],
      [75, 75],
      [25, 75],
      [75, 25],
      [50, 50],
    ],
    6: [
      [25, 25],
      [75, 75],
      [25, 75],
      [75, 25],
      [25, 50],
      [75, 50],
    ],
  };

  if (value === 0) return null;

  const dots = dotPositions[value] || [];

  return (
    <svg viewBox="0 0 100 100" className="w-8 h-8 md:w-10 md:h-10">
      <rect
        x="5"
        y="5"
        width="90"
        height="90"
        rx="15"
        ry="15"
        className="fill-white shadow-lg"
      />
      {dots.map(([cx, cy], index) => (
        <circle
          key={index}
          cx={cx}
          cy={cy}
          r="10" // Dot size
          className="fill-current text-gray-900"
        />
      ))}
    </svg>
  );
});

// Inline Board Component
interface BoardProps {
  player: Player;
  gameState: GameState;
  onSelection: (index: number) => void;
}

const Board: React.FC<BoardProps> = React.memo(
  ({ player, gameState, onSelection }) => {
    // Ring color for the active player's board (Player 1 only)
    const laneActive =
      !gameState.rollingDice && player.isActive && player.isFirstPlayer
        ? " ring-4 ring-yellow-400/80"
        : "";
    const waitingForTurn = !player.isActive;

    // Player 1 fills from bottom up (flex-col). Player 2 fills from top down (flex-col-reverse).
    const laneStackDirection = player.isFirstPlayer
      ? "flex-col"
      : "flex-col-reverse";

    return (
      // Board is centered. No external vertical flip needed.
      <section className="flex space-x-3 md:space-x-4">
        {player.board.map((lane, index) => {
          const laneScore = calcLaneScore(lane);
          const isFull = laneIsFull(player.board, index);

          return (
            // The container dictates the overall stacking direction
            <div
              key={index}
              className={`flex flex-col items-center group ${laneStackDirection}`}
            >
              {/* Lane Score Display: Ensure score is always visually placed closest to the center line. 
                           Order is maintained from previous change to keep lane scores central.
                        */}
              <div
                className={`h-6 text-sm font-bold text-center order-2 ${
                  player.isFirstPlayer ? "mt-1" : "mb-1"
                }`}
              >
                <span
                  className={laneScore > 0 ? "text-green-400" : "text-gray-500"}
                >
                  {laneScore}
                </span>
              </div>

              <button
                disabled={
                  waitingForTurn ||
                  gameState.rollingDice ||
                  gameState.gameOver ||
                  !player.isFirstPlayer ||
                  isFull
                }
                onClick={() => onSelection(index)}
                className={`
                                w-16 h-48 md:w-20 md:h-60 flex ${laneStackDirection} justify-end p-2 rounded-xl shadow-2xl 
                                bg-gray-700 border-4 transition-all duration-200 order-1 // Explicitly set button order to 1
                                ${
                                  player.isFirstPlayer
                                    ? "border-yellow-600"
                                    : "border-red-600"
                                }
                                hover:bg-gray-600 disabled:opacity-70 disabled:cursor-not-allowed
                                ${laneActive}
                                ${isFull ? "opacity-80" : ""}
                            `}
              >
                {/* Dice spaces */}
                {lane.map((space, spaceIndex) => (
                  <div
                    key={spaceIndex}
                    className={`
                                        w-full h-1/3 flex items-center justify-center p-1 
                                        transition-colors
                                        ${
                                          space === 0
                                            ? "opacity-30"
                                            : "opacity-100"
                                        }
                                    `}
                  >
                    <DiceFace value={space} />
                  </div>
                ))}
              </button>
            </div>
          );
        })}
      </section>
    );
  }
);

// Main App Component
const App: React.FC = () => {
  const [db, setDb] = useState<Firestore | null>(null);
  const [userId, setUserId] = useState<string>("");
  const [selectedDifficulty, setSelectedDifficulty] = useState<number>(0); // Default to Normal (0)

  // Game State
  const initialPlayerBoard: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const initialPlayer = (
    name: string,
    isFirstPlayer: boolean,
    wins: number = 0
  ): Player => ({
    name,
    isFirstPlayer,
    currentRoll: 0,
    score: 0,
    currency: 100,
    wager: 0,
    wins,
    isActive: false,
    board: initialPlayerBoard.map((lane) => [...lane]), // Deep copy
    id: isFirstPlayer ? "playerOne" : "playerTwo",
  });

  const [playerOneName, setPlayerOneName] = useState("Player");
  const [playerOne, setPlayerOne] = useState<Player>(
    initialPlayer(playerOneName, true)
  );
  const [playerTwo, setPlayerTwo] = useState<Player>(
    initialPlayer("Knucklebot", false)
  );
  const [gameState, setGameState] = useState<GameState>({
    gameOver: true,
    difficulty: 0, // Will be set by startGame
    rollingDice: true,
    isAuthReady: false,
  });

  // --- 6. FIREBASE INITIALIZATION & DATA HOOKS ---

  // 6.1 Initialize Firebase and Auth
  useEffect(() => {
    try {
      const app = initializeApp(firebaseConfig);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);
      setDb(dbInstance);

      const unsubscribe = onAuthStateChanged(authInstance, (currentUser) => {
        if (currentUser) {
          setUserId(currentUser.uid);
        }
        setGameState((prev) => ({ ...prev, isAuthReady: true }));
      });

      // Sign in with custom token or anonymously
      const authenticate = async () => {
        try {
          // NOTE: __initial_auth_token is provided by the Canvas environment for immediate authentication.
          // If running locally, it signs in anonymously.
          if (typeof __initial_auth_token !== "undefined") {
            await withBackoff(() =>
              signInWithCustomToken(authInstance, __initial_auth_token)
            );
          } else {
            await withBackoff(() => signInAnonymously(authInstance));
          }
        } catch (e) {
          console.error("Authentication failed:", e);
        }
      };
      authenticate();

      return () => unsubscribe();
    } catch (e) {
      console.error("Firebase initialization failed:", e);
      setGameState((prev) => ({ ...prev, isAuthReady: true })); // Mark ready even if failed
    }
  }, []);

  // 6.2 Fetch/Listen for User Wins Data
  useEffect(() => {
    if (!db || !userId || !gameState.isAuthReady) return;

    const userDocRef = doc(
      db,
      "artifacts",
      appId,
      "users",
      userId,
      "stats",
      "knucklebuck_stats"
    );

    const unsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          const storedWins = data?.totalWins || 0;
          setPlayerOne((prev) => ({ ...prev, wins: storedWins }));
        }
      },
      (error) => {
        console.error("Error listening to user stats:", error);
      }
    );

    return () => unsubscribe();
  }, [db, userId, gameState.isAuthReady]);

  // 6.3 Firebase Save Data (Replaces localStorage.setItem)
  const saveData = useCallback(
    async (
      winner: Player | undefined,
      finalScoreOne: number,
      finalScoreTwo: number,
      playerOneNewTotalWins: number
    ) => {
      if (!db || !userId) {
        console.error(
          "Cannot save data: Database not initialized or user not authenticated."
        );
        return;
      }

      const batch = writeBatch(db);

      // 1. Update Player 1's Win Count
      if (winner && winner.isFirstPlayer) {
        const userStatsRef = doc(
          db,
          "artifacts",
          appId,
          "users",
          userId,
          "stats",
          "knucklebuck_stats"
        );
        batch.set(
          userStatsRef,
          {
            totalWins: playerOneNewTotalWins,
            lastUpdated: new Date().toISOString(),
          },
          { merge: true }
        );
      }

      // 2. Save Match History (Private for user)
      const matchCollectionRef = collection(
        db,
        "artifacts",
        appId,
        "users",
        userId,
        "matches"
      );
      const matchDocRef = doc(matchCollectionRef); // Auto-generated ID

      const matchData = {
        playerOneName: playerOne.name,
        playerTwoName: playerTwo.name,
        scoreOne: finalScoreOne,
        scoreTwo: finalScoreTwo,
        winnerName: winner?.name || "Draw",
        timestamp: new Date().toISOString(),
        difficulty:
          DIFFICULTY_LEVELS.find((d) => d.value === gameState.difficulty)
            ?.label || "Normal",
      };

      batch.set(matchDocRef, matchData);

      await withBackoff(() => batch.commit());
    },
    [db, userId, playerOne, playerTwo, gameState.difficulty]
  );

  // --- 7. GAME LOGIC FUNCTIONS ---

  const getDiceRoll = useCallback(() => Math.floor(Math.random() * 6 + 1), []);

  const isBoardFull = (board: number[][]) =>
    board.every((lane) => laneIsFull(board, board.indexOf(lane)));

  /**
   * Checks if the game is over and handles the final state transition.
   */
  const isGameOver = useCallback(
    (p1: Player, p2: Player): boolean => {
      // Check if either board is full
      if (isBoardFull(p1.board) || isBoardFull(p2.board)) {
        let winner: Player | undefined;
        let playerOneNewTotalWins: number = p1.wins;

        if (p1.score > p2.score) {
          winner = p1;
          playerOneNewTotalWins = p1.wins + 1;
        } else if (p2.score > p1.score) {
          winner = p2;
        }

        setGameState((prev) => ({ ...prev, gameOver: true, winner }));

        // Save the results
        saveData(winner, p1.score, p2.score, playerOneNewTotalWins);

        return true;
      }
      return false;
    },
    [saveData]
  );

  const handleDiceRoll = useCallback(() => {
    setGameState((prev) => {
      // Only roll if the game is ongoing and the dice roller is active
      if (prev.gameOver) return prev;

      const roll = getDiceRoll();

      if (playerOne.isActive) {
        setPlayerOne((p) => ({ ...p, currentRoll: roll }));
      } else {
        setPlayerTwo((p) => ({ ...p, currentRoll: roll }));
      }

      return { ...prev, rollingDice: false };
    });
  }, [playerOne.isActive, getDiceRoll]);

  const makeSelection = useCallback(
    (index: number) => {
      const activePlayer = playerOne.isActive ? playerOne : playerTwo;
      const otherPlayerBoard = activePlayer.isFirstPlayer
        ? playerTwo.board
        : playerOne.board;

      // Simple check for move validity
      if (
        activePlayer.currentRoll === 0 ||
        laneIsFull(activePlayer.board, index)
      ) {
        console.warn("Invalid move attempted: No die rolled or lane is full.");
        return;
      }

      // 1. Place the die (Calculates newPlayerBoard)
      const newPlayerBoard = activePlayer.board.map((lane, i) => {
        if (i === index) {
          // Find the first empty slot (0)
          const y = lane.findIndex((val) => val === 0);
          if (y !== -1) {
            const newLane = [...lane];
            newLane[y] = activePlayer.currentRoll;
            return newLane;
          }
        }
        return lane;
      });

      // 2. Clear matches on the opponent's board (Calculates newOtherPlayerBoard)
      const newOtherPlayerLane = clearMatches(
        otherPlayerBoard[index],
        activePlayer.currentRoll
      );
      const newOtherPlayerBoard = otherPlayerBoard.map((lane, i) =>
        i === index ? newOtherPlayerLane : lane
      );

      // 3. Calculate NEW scores
      const newPlayerScore = calcTotalScore(newPlayerBoard);
      const newOtherPlayerScore = calcTotalScore(newOtherPlayerBoard);

      // 4. Create new player objects with updated board and score
      const newP1: Player = activePlayer.isFirstPlayer
        ? {
            ...playerOne,
            board: newPlayerBoard,
            score: newPlayerScore,
            currentRoll: 0,
            isActive: false,
          }
        : {
            ...playerOne,
            board: newOtherPlayerBoard,
            score: newOtherPlayerScore,
            currentRoll: 0,
            isActive: true,
          };

      const newP2: Player = activePlayer.isFirstPlayer
        ? {
            ...playerTwo,
            board: newOtherPlayerBoard,
            score: newOtherPlayerScore,
            currentRoll: 0,
            isActive: true,
          }
        : {
            ...playerTwo,
            board: newPlayerBoard,
            score: newPlayerScore,
            currentRoll: 0,
            isActive: false,
          };

      // 5. Check for Game Over (using the new, final board/score state)
      if (isGameOver(newP1, newP2)) {
        // If game over, set the final board/score states (isActive/currentRoll will be reset by isGameOver)
        setPlayerOne(newP1);
        setPlayerTwo(newP2);
        return;
      }

      // 6. Set the final state for the next turn and start rolling dice
      setPlayerOne(newP1);
      setPlayerTwo(newP2);

      setGameState((prev) => ({ ...prev, rollingDice: true }));
    },
    [playerOne, playerTwo, isGameOver]
  );

  // Effect to handle the dice roll initiation and AI move execution
  useEffect(() => {
    if (gameState.gameOver) return;

    // Initiate dice roll when the turn starts
    if (gameState.rollingDice) {
      const timer = setTimeout(handleDiceRoll, 500);
      return () => clearTimeout(timer);
    }

    // Initiate Knucklebot move if it's their turn
    if (
      playerTwo.isActive &&
      !gameState.rollingDice &&
      playerTwo.currentRoll !== 0
    ) {
      // --- AI Move Execution ---
      const selectionIndex = knucklebotMove(
        playerOne.board,
        playerTwo.board,
        playerTwo.currentRoll,
        gameState.difficulty, // Pass difficulty here
        gameState.gameOver
      );
      // --- End AI Move Execution ---

      // Wait a moment before making the AI move for visual effect
      const aiTimer = setTimeout(() => {
        makeSelection(selectionIndex);
      }, 1500);

      return () => clearTimeout(aiTimer);
    }
  }, [
    gameState.gameOver,
    gameState.rollingDice,
    playerOne.board,
    playerTwo.isActive,
    playerTwo.board,
    playerTwo.currentRoll,
    gameState.difficulty,
    handleDiceRoll,
    makeSelection,
  ]);

  // Memoized derived states for UI
  const inactivePlayer = playerOne.isActive ? playerTwo : playerOne; // Used in Game Over Screen

  /**
   * Function to start or reset the game.
   */
  const startGame = useCallback(() => {
    const p1Wins = playerOne.wins;
    const p2Wins = playerTwo.wins;

    const newP1 = initialPlayer(playerOneName, true, p1Wins);
    const newP2 = initialPlayer("Knucklebot", false, p2Wins);

    newP1.isActive = true;

    setPlayerOne(newP1);
    setPlayerTwo(newP2);
    setGameState({
      gameOver: false,
      difficulty: selectedDifficulty, // Use selected difficulty from UI
      rollingDice: true,
      winner: undefined,
      isAuthReady: gameState.isAuthReady,
    });

    // handleDiceRoll will be called via useEffect
  }, [
    playerOne.wins,
    playerTwo.wins,
    playerOneName,
    gameState.isAuthReady,
    selectedDifficulty,
  ]);

  // Handle initial state setup on name change/load
  useEffect(() => {
    if (!gameState.gameOver) {
      setPlayerOne((p) => ({ ...p, name: playerOneName }));
    }
  }, [playerOneName, gameState.gameOver]);

  if (!gameState.isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full bg-gray-900 text-white">
        <div className="text-xl p-4 rounded-lg bg-gray-800 shadow-xl animate-pulse">
          <svg
            className="animate-spin -ml-1 mr-3 h-5 w-5 text-yellow-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          Loading Knucklebuck...
        </div>
      </div>
    );
  }

  // --- 8. UI RENDERING (JSX with Tailwind) ---
  // Recalculating activePlayer here since it's only needed for the message display
  const activePlayer = playerOne.isActive ? playerOne : playerTwo;

  // SVG for Dice Icon in the HUD
  const CurrentRollDice: React.FC<{ roll: number; color: string }> = ({
    roll,
    color,
  }) => {
    if (roll === 0)
      return (
        <div
          className={`text-5xl md:text-6xl text-gray-700 font-mono flex items-center justify-center w-16 h-16 md:w-20 md:h-20`}
        >
          ?
        </div>
      );

    // Dot positions (relative to a 100x100 grid)
    const dotPositions: { [key: number]: [number, number][] } = {
      1: [[50, 50]],
      2: [
        [25, 25],
        [75, 75],
      ],
      3: [
        [25, 25],
        [50, 50],
        [75, 75],
      ],
      4: [
        [25, 25],
        [75, 75],
        [25, 75],
        [75, 25],
      ],
      5: [
        [25, 25],
        [75, 75],
        [25, 75],
        [75, 25],
        [50, 50],
      ],
      6: [
        [25, 25],
        [75, 75],
        [25, 75],
        [75, 25],
        [25, 50],
        [75, 50],
      ],
    };
    const dots = dotPositions[roll] || [];

    return (
      <div className="w-16 h-16 md:w-20 md:h-20 flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <rect
            x="0"
            y="0"
            width="100"
            height="100"
            rx="20"
            ry="20"
            className={`fill-white shadow-xl ${
              color === "yellow"
                ? "ring-4 ring-yellow-400"
                : "ring-4 ring-red-400"
            }`}
          />
          {dots.map(([cx, cy], index) => (
            <circle
              key={index}
              cx={cx}
              cy={cy}
              r="10"
              className={`fill-current text-gray-900`}
            />
          ))}
        </svg>
      </div>
    );
  };

  return (
    <div className="min-h-screen w-full bg-gray-900 font-inter text-white flex flex-col items-center p-2 sm:p-4">
      <h1 className="text-3xl sm:text-4xl font-extrabold mb-4 sm:mb-6 text-yellow-500 tracking-wider drop-shadow-lg">
        KNUCKLEBUCK
      </h1>

      {/* Start Screen / Game Over Screen */}
      {gameState.gameOver ? (
        <div className="flex flex-col items-center justify-center w-full max-w-sm sm:max-w-lg bg-gray-800 p-6 sm:p-8 rounded-2xl shadow-2xl mt-4 sm:mt-8 border border-gray-700">
          {!gameState.winner ? (
            /* Welcome/Start Screen */
            <>
              <h5 className="text-base sm:text-lg mb-4 text-gray-300">
                Total Wins:{" "}
                <span className="font-mono text-xl">{playerOne.wins}</span>
              </h5>

              <label
                htmlFor="player-name"
                className="text-base sm:text-lg mb-2 text-gray-400 self-start"
              >
                Enter your name:
              </label>
              <input
                id="player-name"
                className="w-full p-3 mb-4 rounded-xl text-gray-900 bg-white border-2 border-yellow-500 focus:ring-2 focus:ring-yellow-400 transition-all shadow-inner"
                type="text"
                value={playerOneName}
                onChange={(e) => setPlayerOneName(e.target.value)}
                placeholder="The Dice Slinger"
              />

              {/* Difficulty Selection */}
              <label
                htmlFor="difficulty-select"
                className="text-base sm:text-lg mb-2 text-gray-400 self-start"
              >
                Select Knucklebot Difficulty:
              </label>
              <select
                id="difficulty-select"
                value={selectedDifficulty}
                onChange={(e) =>
                  setSelectedDifficulty(parseInt(e.target.value))
                }
                className="w-full p-3 mb-6 rounded-xl text-gray-900 bg-white border-2 border-red-500 focus:ring-2 focus:ring-red-400 transition-all shadow-inner appearance-none"
              >
                {DIFFICULTY_LEVELS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="w-full py-3 px-6 bg-yellow-600 hover:bg-yellow-500 text-gray-900 font-extrabold text-xl rounded-xl shadow-xl transition duration-200 disabled:opacity-50 disabled:shadow-none transform hover:scale-[1.01] active:scale-[0.99]"
                disabled={!playerOneName}
                onClick={startGame}
              >
                START GAME
              </button>
              {/* Reverting back to placeholder link text for rules */}
              <a
                href="/rules.md"
                className="text-xs sm:text-sm mt-4 text-gray-500 hover:text-gray-400 transition-colors"
              >
                [Rules & Scoring Placeholder]
              </a>
            </>
          ) : (
            /* Game Over Screen */
            <div className="text-center">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4 text-red-400 uppercase tracking-widest">
                Match Ended
              </h2>
              <p className="text-sm text-gray-500 mb-2">
                Difficulty:{" "}
                {DIFFICULTY_LEVELS.find((d) => d.value === gameState.difficulty)
                  ?.label || "Normal"}
              </p>
              <h1 className="text-xl md:text-3xl font-semibold mb-6">
                {gameState.winner.isFirstPlayer ? (
                  <>
                    🏆 Victory!{" "}
                    <span className="text-yellow-400">
                      {gameState.winner.name}
                    </span>
                    !
                    <br /> Score: {gameState.winner.score} -{" "}
                    {inactivePlayer.score}
                  </>
                ) : (
                  <>
                    Defeat!{" "}
                    <span className="text-red-400">
                      {gameState.winner.name}
                    </span>{" "}
                    wins.
                    <br /> Score: {inactivePlayer.score} -{" "}
                    {gameState.winner.score}
                  </>
                )}
              </h1>
              <p className="text-base sm:text-lg text-gray-400 mb-6">
                Your total wins: {playerOne.wins}
              </p>
              <button
                type="button"
                className="mt-4 w-full py-3 px-6 bg-yellow-600 hover:bg-yellow-500 text-gray-900 font-extrabold text-xl rounded-xl shadow-xl transition duration-200 transform hover:scale-[1.01] active:scale-[0.99]"
                onClick={startGame}
              >
                PLAY AGAIN
              </button>
            </div>
          )}
        </div>
      ) : (
        /* Active Game Screen */
        <div className="flex flex-col w-full max-w-4xl space-y-4 sm:space-y-6">
          {/* Enemy (Player Two) Section - Top */}
          <div className="flex justify-between items-center p-2 sm:p-4 bg-gray-800 rounded-xl shadow-inner shadow-gray-900 border-t-4 border-red-600">
            {/* Mobile Optimized Player Info Block */}
            <div className="w-1/4 flex flex-col items-center">
              <h3
                className={`text-sm md:text-xl font-bold ${
                  playerTwo.isActive ? "text-red-400" : "text-gray-500"
                } text-center`}
              >
                {playerTwo.name}
              </h3>
              <span className="text-2xl md:text-3xl font-mono text-red-300 drop-shadow-md">
                {playerTwo.score}
              </span>
            </div>
            <div className="w-1/2 flex justify-center">
              {/* Board is rendered top-down using flex-col-reverse in its component logic */}
              <Board
                player={playerTwo}
                gameState={gameState}
                onSelection={makeSelection}
              />
            </div>
            <div className="w-1/4 flex justify-center">
              <CurrentRollDice roll={playerTwo.currentRoll} color="red" />
            </div>
          </div>

          {/* Game Info / Dice Roll - Middle */}
          <div className="flex justify-center items-center h-10 sm:h-12">
            <div className="text-sm sm:text-lg font-semibold text-gray-400 bg-gray-700/50 px-3 py-1 sm:px-4 sm:py-2 rounded-full shadow-md">
              {gameState.rollingDice ? (
                <span className="text-yellow-400 animate-pulse font-bold">
                  ROLLING DICE...
                </span>
              ) : (
                <span
                  className={`font-bold ${
                    activePlayer.isFirstPlayer
                      ? "text-yellow-400"
                      : "text-red-400"
                  }`}
                >
                  {activePlayer.name}'s turn (Roll: {activePlayer.currentRoll})
                </span>
              )}
            </div>
          </div>

          {/* Player One Section - Bottom */}
          <div className="flex justify-between items-center p-2 sm:p-4 bg-gray-800 rounded-xl shadow-inner shadow-gray-900 border-b-4 border-yellow-600">
            <div className="w-1/4 flex justify-center">
              <CurrentRollDice roll={playerOne.currentRoll} color="yellow" />
            </div>
            <div className="w-1/2 flex justify-center">
              <Board
                player={playerOne}
                gameState={gameState}
                onSelection={makeSelection}
              />
            </div>
            {/* Mobile Optimized Player Info Block */}
            <div className="w-1/4 flex flex-col items-center">
              <h3
                className={`text-sm md:text-xl font-bold ${
                  playerOne.isActive ? "text-yellow-400" : "text-gray-500"
                } text-center`}
              >
                {playerOne.name}
              </h3>
              <span className="text-2xl md:text-3xl font-mono text-yellow-300 drop-shadow-md">
                {playerOne.score}
              </span>
            </div>
          </div>
        </div>
      )}
      <p className="mt-4 sm:mt-8 text-xs text-gray-600">User ID: {userId}</p>
    </div>
  );
};

export default App;
