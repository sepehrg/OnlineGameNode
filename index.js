var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var fs = require('fs');

const express = require('express');
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

var jsdom = require("jsdom");
const { JSDOM } = jsdom;
const { window } = new JSDOM();
const { document } = (new JSDOM('')).window;
global.document = document;
var $ = jQuery = require('jquery')(window);

const request = require('request');

var scheduler = require('node-schedule');

// routing
app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

var url = 'http://localhost:3033/';
//var url = 'http://192.168.1.70:7373/';
var serverAvailable = true;
var profileIds = {};
var waitingList = [];
var questionsAnswered = [];
////group:
var questionIndex = 0;
var questions = [];
var gameIsStarted = false;
var gameStartIsNotified = false;
var questionResponses = [];
var answerTimeout = 10; //seconds
var scoreMode = false;
var isPaused = false;
var notifyMinutesStart = 2;
var nextActionRemainingSeconds = 0;
var currentQuestion = {};
var currentGroupGame = {};

io.sockets.on('connection', function (socket) {

    socket.on('add_admin', function () {
        socket.join('admin');
    });

    socket.on('add_to_group_room', function () {
        socket.join('players');
        socket.emit('updatechat', 'SERVER', 'You have entered the game');
        io.to('players').emit('update_room_count', io.sockets.adapter.rooms['players'].length);
        io.to('admin').emit('update_room_count', io.sockets.adapter.rooms['players'].length);
        if (gameIsStarted) {
            socket.emit('late_join', {
                'CurrentQuestion': currentQuestion,
                'RemainingTime': nextActionRemainingSeconds,
                'GroupGameId': currentGroupGame.Id
            });
        }
    });

    socket.on('remove_from_group_room', function () {
        socket.leave('players');
        if (io.sockets.adapter.rooms['players']) {
            io.to('players').emit('update_room_count', io.sockets.adapter.rooms['players'].length);
            io.to('admin').emit('update_room_count', io.sockets.adapter.rooms['players'].length);
        }
        else {
            io.to('admin').emit('update_room_count', 0);
        }
    });

    socket.on('start_group_game', function (groupGame) {
        startGroupGame(JSON.parse(groupGame));
    });

    function startGroupGame(groupGame) {
        if (io.sockets.adapter.rooms['players']) {
            io.to('players').emit('set_game_id', groupGame.Id);
            io.to('admin').emit('set_game_id', groupGame.Id);
            groupGame.IsStarted = true;
            currentGroupGame = groupGame;
            updateGroupGame(groupGame);
            gameIsStarted = true;
            socket.emit('updatechat', 'SERVER', 'Game started with ' + io.sockets.adapter.rooms['players'].length + ' players');

            if (serverAvailable) {
                const options = {
                    url: url + 'api/GetAllGroupGameQuestions?groupGameId=' + groupGame.Id,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Charset': 'utf-8',
                        'token': socket.token
                    }
                };

                request(options, function (err, res, body) {
                    questions = JSON.parse(body).Data;
                    if (questions)
                        showQuestion();
                    else
                        socket.emit('updatechat', 'SERVER', 'No questions found');
                });
            }
            else {
                questions = getFakeQuestions().Data.Questions;
                showQuestion();
            }
        } else {
            socket.emit('updatechat', 'SERVER', 'There is no one in the room');
        }
    }

    function updateGroupGame(groupGame) {
        if (serverAvailable) {
            const options = {
                url: url + 'api/UpdateGroupGame',
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Accept-Charset': 'utf-8',
                    'token': socket.token
                },
                form: groupGame
            };

            request(options, function (err, res, body) {
                if (!JSON.parse(body).HasError)
                    console.log('game updated');
                else
                    console.log('error updating game: ' + body);

            });
        }
    }

    socket.on('notify_group_game', function (groupGame, minutes) {
       notifyStartGroupGame(groupGame, minutes);
    });
	
    function notifyStartGroupGame(groupGame, minutes) {
		var obj = JSON.parse(groupGame);
        gameStartIsNotified = true;
        obj.IsStartNotified = true;
        updateGroupGame(obj);
        socket.broadcast.emit('notify_start_game', minutes);
    }

    socket.on('pause_game', function () {
        if (isPaused) {
            isPaused = false;
            console.log("game resumed");
        } else {
            isPaused = true;
            console.log("game paused");
        }
    });

    function showQuestion() {
        currentQuestion = questions[questionIndex];
        if (currentQuestion) {
            io.to('players').emit('show_question', { question: currentQuestion, scoreMode: scoreMode });
            io.to('admin').emit('show_question', { question: currentQuestion, scoreMode: scoreMode });
            //timer for showing answer
            countDown(function () {
                var t2 = setInterval(function () {
                    if (!isPaused) {
                        clearInterval(t2);
                        io.to('players').emit('show_answer',
                            {
                                answer: currentQuestion.Answer,
                                stat: groupByArray(questionResponses, "Answer"),
                                scoreMode: scoreMode
                            });
                        io.to('admin').emit('show_answer',
                            {
                                answer: currentQuestion.Answer,
                                stat: groupByArray(questionResponses, "Answer"),
                                scoreMode: scoreMode
                            });
                        questionIndex++;

                        //timer for showing next question
                        countDown(function () {
                            var t = setInterval(function () {
                                if (!isPaused) {
                                    clearInterval(t);
                                    questionResponses = [];
                                    showQuestion();
                                }
                            }, 1000);
                        }, currentQuestion.Delay);
                    }
                }, 1000);
            }, answerTimeout)
        }
        else {
            questionIndex = 0;
            gameIsStarted = false;
            gameStartIsNotified = false;
            io.to('players').emit("game_end");
            io.to('admin').emit("game_end");
            calculateGroupGameResult(currentGroupGame.Id);
        }
    }

    socket.on('save_response', function (answer,qId) {
        //console.log('DB: profileId:' + socket.profileId + ' questionId:' + result.questionId + ' response:' + result.response);
        var question = questions.filter(q => q.QuestionID == qId)[0];
        console.log(answer + ', ' + qId);
        var correctAnswer = false;
        if (answer == question.Answer) {
            correctAnswer = true;
        }

        questionResponses.push({ 'ProfileId': socket.profileId, 'QuestionId': qId, 'Answer': answer, 'CorrectAnswer': correctAnswer });

        //if not in score mode and answer is wrong, lose game is called
        if (!scoreMode && !correctAnswer) {
            socket.emit("lose_game");
        }
    });

    function groupByArray(xs, key) {
        return count(xs.reduce(function (rv, x) {
            let v = key instanceof Function ? key(x) : x[key];
            let el = rv.find((r) => r && r.key === v);
            if (el) {
                el.values.push(1);
            } else {
                rv.push({ key: v, values: [1] });
            }
            return rv;
        }, []));
    }

    function count(arr) {
        var result = [];
        $.each(arr, function (k, v) {
            result.push({ 'key': v.key, 'count': v.values.length });
        });
        return result;
    }

    socket.on('load_schedules', function (scheduleList) {
        Object.values(scheduleList.Data).forEach(function (sch) {
            var gameArgs = { "GameInfo": sch };
            var event = new GameEvent(new Date(sch.StartDate).addMinutes(-notifyMinutesStart), "notifyStartGame", gameArgs);
            event.schedule();
            var event2 = new GameEvent(new Date(sch.StartDate), "startGame", gameArgs);
            event2.schedule();
        });
    });

    var GameEvent = function (when, what, args) {
        this.when = when;
        this.what = what;
        this.args = args;
    };

    GameEvent.Actions = {
        startGame: function (args, cb) {
            startGroupGame(args.GameInfo);
        },
        notifyStartGame: function (args, cb) {
            notifyStartGroupGame(args.GameInfo, notifyMinutesStart)
        }
    }


    GameEvent.prototype.schedule = function () {
        var self = this;
        var handler = GameEvent.Actions[this.what];
        io.to('admin').emit('updatechat', 'SERVER', this.what + ' is scheduled for ' + self.when);
        self._event = scheduler.scheduleJob(self.when, function () {
            handler(self.args, function (err, result) {
                if (err) {
                    console.error('event ' + self + ' failed:' + err);
                }
            });
        });
    }

    Date.prototype.addMinutes = function (m) {
        this.setTime(this.getTime() + (m * 60 * 1000));
        return this;
    }

    socket.on('send_friend_request', function (friendId) {
        if (serverAvailable) {
            const options = {
                url: url + 'api/InsertFriendList?friendId=' + friendId,
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Accept-Charset': 'utf-8',
                    'token': socket.token
                }
            };
            request(options, function (err, res, body) {
                if (JSON.parse(body).HasError) {
                    if (JSON.parse(body).Error.ErrorCode == 4) {
                        socket.emit('updatechat', 'SERVER', 'Friend is already invited.');
                    }
                }
                else {
                    if (profileIds[friendId])
                        io.sockets.connected[profileIds[friendId]].emit('show_friend_request', socket.profileId);
                    socket.emit('updatechat', 'SERVER', 'Friend is invited.');
                    getFriendList();
                }
            });
        }
        else {
            socket.emit('updatechat', 'SERVER', 'Feature is not available offline!');
        }
    });

    socket.on('respond_friend_request', function (response) {

        const options = {
            url: url + 'api/UpdateFriendList',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-Charset': 'utf-8',
                'token': socket.token
            },
            form: {
                ProfileId: response.InviterId,
                Status: response.InviteResponse ? 1 : 2
            }
        };

        request(options, function (err, res, body) {

            if (JSON.parse(body).Error.ErrorCode == 0) {
                socket.emit('updatechat', 'SERVER', 'Request updated');
                getFriendList();

                if (io.sockets.connected[profileIds[response.InviterId]])
                    io.sockets.connected[profileIds[response.InviterId]].emit('notify_friend_list_updated');
            }
            else
                console.log(JSON.parse(body))
        });
    });

    function getFriendList() {
        const options = {
            url: url + 'api/GetAllFriendList?type=1',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-Charset': 'utf-8',
                'token': socket.token
            }
        };
        request(options, function (err, res, body) {
            if (JSON.parse(body).Data) {
                var list = JSON.parse(body).Data;
                var list2 = [];
                list.forEach(function (item) {
                    list2.push({
                        FriendId: item.FriendId,
                        Status: item.Status,
                        IsOnline: profileIds[item.FriendId] ? true : false
                    });
                });
                socket.friendList = list2;
                socket.emit('show_friend_list', list2);
            }
            else
                console.log('profileId: ' + socket.profileId + ':' + body);
        });
    }

    socket.on('get_friend_list', function () {
        getFriendList();
    });

    socket.on('beep_friend', function (profileId) {
        if (io.sockets.connected[profileIds[profileId]])
            io.sockets.connected[profileIds[profileId]].emit('show_beep', socket.profileId);
    });

    function countDown(functionToExecute, delay) {
        var startDate = Date.now();
        countDownTimer = setInterval(function () {
            var timeLeft = delay - Math.ceil((Date.now() - startDate) / 1000);
            if (timeLeft > 0) {
                nextActionRemainingSeconds = timeLeft;
            }
            else {
                functionToExecute();
                clearInterval(countDownTimer);
            }
        }, 1000);
    }

    socket.on('get_game_status', function () {
        socket.emit('show_game_status', gameIsStarted);
    });

    function calculateGroupGameResult(id) {
        setTimeout(function () {
            const options = {
                url: url + 'api/CalculateGroupGameResult?groupGameId='+id,
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Accept-Charset': 'utf-8',
                    'token': socket.token
                }
            };
            request(options, function (err, res, body) {
                if (JSON.parse(body).Data) {
                    io.to('players').emit('show_game_result', JSON.parse(body).Data);
                    io.to('admin').emit('show_game_result', JSON.parse(body).Data);
                }
                else
                    console.log('calculate result: ' + body);
            });
        }, 5000);
    }












    // when the client emits 'adduser', this listens and executes
    socket.on('adduser', function (profileId, token) {
        // we store the profileId in the socket session for this client
        socket.token = token;
        socket.profileId = profileId;
        socket.timer = 0;
        socket.countAnswer = 0;
        // add the client's profileId to the global list
        profileIds[profileId] = socket.id;
        //console.log(profileIds);
        getFriendList();
        setTimeout(function () {
            if (socket.friendList) {
                socket.friendList.forEach(function (item) {
                    if (item.IsOnline) {
                        if (io.sockets.connected[profileIds[item.FriendId]])
                            io.sockets.connected[profileIds[item.FriendId]].emit('notify_friend_list_updated');
                    }
                });
            }
        }, 1000);
        
        if (gameStartIsNotified) {
            socket.emit('notify_start_game', 0);
        }
    });
    socket.on('adduserReconnect', function (profileId, opponetId, token) {
        // we store the profileId in the socket session for this client
        socket.token = token;
        socket.profileId = profileId;
        socket.opponentId = opponetId;
        socket.timer = 0;
        // add the client's profileId to the global list
        profileIds[profileId] = socket.id;
    });

    //user A
    socket.on('submit_opponent', function (catId, opponentId) {
        //socket.quiz = [];
        socket.opponentId = opponentId;
        socket.catId = catId;

        if (socket.profileId == opponentId) {
            io.sockets.connected[profileIds[socket.profileId]].emit('message', 'Error', 'You can not play with yourself');
            return;
        }

        setTimeout(function () {
            if (opponentId != 0) {
                console.log('DB: SaveInvite(profileId:' + socket.profileId + ', opponentId:' + socket.opponentId + ', catId:' + catId + ')');

                const options = {
                    url: url + 'api/PrepareMulti',
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Charset': 'utf-8',
                        'token': socket.token
                    },
                    form: {
                        CatId: catId,
                        OpponentId: opponentId
                    }
                };
                if (serverAvailable) {
                    request(options, function (err, res, body) {
                        if (err)
                            console.log(err);
                        else {
                            if (JSON.parse(body).Data) {
                                let result = JSON.parse(body).Data[0];
                                console.log(result);
                                socket.quizId = result.QuizID;
                                socket.matchId = result.MatchID;
                                socket.matchId2 = result.MatchID2;

                                console.log("invite_done   " + result.InviteID, result.MatchID);

                                io.sockets.connected[profileIds[socket.profileId]].emit('invite_done', result.InviteID, result.MatchID);

                                if (profileIds[socket.opponentId]) {
                                    io.sockets.connected[profileIds[opponentId]].emit('invite_user', socket.profileId, catId, socket.matchId);
                                }

                            }
                            else {
                                console.log(JSON.parse(body))
                            }
                        }
                    });
                }
                else {
                    socket.quizId = 100;
                    socket.matchId = 200;
                    socket.matchId2 = 201;

                    io.sockets.connected[profileIds[socket.profileId]].emit('invite_done', 11, 200);

                    io.sockets.connected[profileIds[opponentId]].emit('invite_user', socket.profileId, catId);
                }
            }
        }, 1);
    });

    socket.on('send_invite_again', function (catId, opponentId, matchId) {
        console.log("oppoentId   " + opponentId);
        socket.opponentId = opponentId;
        socket.catId = catId;
        if (profileIds[socket.opponentId]) {
            io.sockets.connected[profileIds[opponentId]].emit('invite_user', socket.profileId, catId, matchId);
        } else {
            console.log("user not online    " + opponentId);
        }
    });



    //user B
    socket.on('invite_user_response', function (res, invitedId, inviterId, catId) {
        socket.opponentId = inviterId;
        try {
            if (res) {
                io.sockets.connected[profileIds[inviterId]].emit('invite_accepted');
            }
            else {
                io.sockets.connected[profileIds[inviterId]].emit('message', 'Notice', 'rejected');
                io.sockets.connected[profileIds[inviterId]].emit('invite_rejected');
            }
        }
        catch (err) {
            console.log(err.message);
        }
    });



    //user A/B
    socket.on('confirm_get_questions', function (order, quizId) {
        //if (order == 'B')
        //    socket.quiz.push({ "QuizId": quizId, "ProfileId": socket.profileId, UserAnswers: [] });

        io.sockets.connected[profileIds[socket.profileId]].emit('start');
    });

    //  edit by farhad
    socket.on('notify_answered', function (response, question, quizId, score, asnwerScore) {

        console.log("score oppnet is " + score + "  profileId" + socket.profileId);
        if (profileIds[socket.opponentId]) {
            io.sockets.connected[profileIds[socket.opponentId]].emit('notify_answered', response, score, asnwerScore);
        } else {
            console.log("oppnect user is disconnected");
        }
    });

    // farhad
    socket.on('get_next_question', function () {
        console.log("get_next_question   " + socket.profileId);
        if (profileIds[socket.profileId])
            io.sockets.connected[profileIds[socket.profileId]].emit('get_next_question');
        if (profileIds[socket.opponentId])
            io.sockets.connected[profileIds[socket.opponentId]].emit('get_next_question');

    });

    socket.on('quiz_exit', function () {
        if (profileIds[socket.opponentId]) {
            io.sockets.connected[profileIds[socket.opponentId]].emit('game_finished');
            console.log("quiz_exit      " + socket.profileId);
        }
    });


    socket.on('quiz_finished', function (quizId, userAnswers) {

        console.log('DB: SaveQuizResult(quizId:' + quizId + ', matchId:' + socket.matchId + ', userAnswers:' + userAnswers + ')');

    });


    //user A/B
    socket.on('add_to_waiting_list', function (catId) {
        waitingList.push({ "CatId": catId, "ProfileId": socket.profileId });
        check_can_play(catId)
    });

    //user A/B
    function check_can_play(catId) {
        //if I'm not in the list, someone has invited me, do nothing
        if (!waitingList.some(q => q.ProfileId == socket.profileId))
            return;

        //find opponent
        var opponentId = 0;
        $.each(waitingList, function (key, value) {
            if (value.CatId == catId && value.ProfileId != socket.profileId) {
                opponentId = value.ProfileId;
                return false;
            }
        });
        if (opponentId) {
            //remove me and opponent from waiting list and submit opponent
            //Edit By Farhad
            socket.timer = 0;
            waitingList = waitingList.filter(q => q.ProfileId != opponentId && q.ProfileId != socket.profileId);
            submit_opponent_auto(catId, opponentId);
        }
        else {
            //wait and call again
            setTimeout(function () {
                if (socket.timer < 10) {
                    check_can_play(catId);
                    socket.timer++;
                    console.log(socket.profileId + ":" + socket.timer);
                }
                else {
                    //remove me from waiting list and play with robot
                    //Edit By Farhad
                    socket.timer = 0;
                    waitingList = waitingList.filter(q => q.ProfileId != socket.profileId);

                    // call function notify_robot_selected
                    // socket.emit('notify_robot_selected', catId);
                    notify_robot_selected(catId);

                }
            }, 1000)
        }
    }

    //user A
    function notify_robot_selected(catId) {
        //socket.quiz = [];
        socket.opponentId = 1;
        socket.catId = catId;

        setTimeout(function () {
            console.log('DB: SaveInvite(profileId:' + socket.profileId + ', opponentId:' + socket.opponentId + ', catId:' + catId + ') to play with robot');

            const options = {
                url: url + 'api/PrepareMulti',
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Accept-Charset': 'utf-8',
                    'token': socket.token
                },
                form: {
                    CatId: catId,
                    OpponentId: socket.opponentId
                }
            };
            if (serverAvailable) {
                request(options, function (err, res, body) {
                    if (err)
                        console.log(err);
                    else {
                        if (JSON.parse(body).Data) {
                            let result = JSON.parse(body).Data[0];
                            console.log(result);
                            socket.quizId = result.QuizID;
                            socket.matchId = result.MatchID;

                            socket.emit('notify_robot_selected', catId, socket.matchId);

                        }
                        else {
                            console.log(JSON.parse(body))
                        }
                    }
                });
            } else {
                socket.quizId = 700;
                socket.matchId = 800;
                socket.emit('notify_robot_selected', catId, socket.matchId);
            }
        }, 1);
    }

    //user A
    socket.on('submit_opponent_robot', function (catId) {
        pre_start_robot();
    });
    //user A
    function pre_start_robot() {
        const options = {
            url: url + 'api/GetQuestions',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-Charset': 'utf-8',
                'token': socket.token
            },
            form: {
                quizId: socket.quizId
            }
        };

        if (serverAvailable) {
            request(options, function (err, res, body) {
                let result = JSON.parse(body).Data;
                console.log(result);

                if (profileIds[socket.profileId]) {
                    io.sockets.connected[profileIds[socket.profileId]].emit('get_questions', result);
                }

                //socket.quiz.push({ "QuizId": result.QuizId, "ProfileId": socket.profileId, UserAnswers: [] });
            });
        } else {
            // edit by farhad
            io.sockets.connected[profileIds[socket.profileId]].emit('get_questions', getFakeQuestions().Data);
        }
    }

    socket.on("confirm_opponet", function (opponetId) {
        console.log("confirm_opponet");
        socket.opponentId = opponetId;

    });

    //user B
    function submit_opponent_auto(catId, opponentId) {
        socket.opponentId = opponentId;
        socket.catId = catId;

        setTimeout(function () {
            if (opponentId != 0) {
                console.log('DB: SaveInvite(profileId:' + socket.profileId + ', opponentId:' + socket.opponentId + ', catId:' + catId + ')');

                const options = {
                    url: url + 'api/PrepareMulti',
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Accept-Charset': 'utf-8',
                        'token': socket.token
                    },
                    form: {
                        CatId: catId,
                        OpponentId: opponentId,
                        AutoInvite: true
                    }
                };
                if (serverAvailable) {
                    request(options, function (err, res, body) {
                        if (err)
                            console.log(err);
                        else {
                            if (JSON.parse(body).Data) {
                                let result = JSON.parse(body).Data[0];
                                console.log(result);
                                socket.quizId = result.QuizID;
                                socket.matchId = result.MatchID;
                                socket.matchId2 = result.MatchID2;
                                socket.opponentId = opponentId;
                                // Edit By Farhad
                                console.log("invite_accepted_auto opponentId " + opponentId + "profileId  " + socket.profileId);

                                if (profileIds[socket.opponentId]) {
                                    io.sockets.connected[profileIds[socket.profileId]].emit('invite_accepted_auto', opponentId, socket.quizId, socket.matchId, socket.matchId2, false);
                                    io.sockets.connected[profileIds[opponentId]].emit('invite_accepted_auto', socket.profileId, socket.quizId, socket.matchId, socket.matchId2);
                                }

                            }
                            else {
                                console.log(JSON.parse(body))
                            }
                        }
                    });
                }
                else {
                    socket.quizId = 300;
                    socket.matchId = 400;
                    socket.matchId2 = 401;
                    // Edit By Farhad
                    console.log("invite_accepted_auto opponentId " + opponentId + "profileId  " + socket.profileId);
                    io.sockets.connected[profileIds[opponentId]].emit('invite_accepted_auto', socket.profileId, socket.quizId, socket.matchId, socket.matchId2);
                    io.sockets.connected[profileIds[socket.profileId]].emit('invite_accepted_auto', opponentId, socket.quizId, socket.matchId, socket.matchId2, false);

                }
            }
        }, 1);
    }

    socket.on('pre_start', function (quizId) {

        if (quizId) {
            socket.quizId = quizId;
        }

        console.log('quiz From Clinet:' + quizId);
        console.log('quiz:' + socket.quizId);
        const options = {
            url: url + 'api/GetQuestions',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-Charset': 'utf-8',
                'token': socket.token
            },
            form: {
                quizId: socket.quizId
            }
        };
        if (serverAvailable) {
            request(options, function (err, res, body) {
                let result = JSON.parse(body).Data;
                console.log(result);
                if (profileIds[socket.opponentId]) {
                    io.sockets.connected[profileIds[socket.profileId]].emit('get_questions', result, 'A');
                    io.sockets.connected[profileIds[socket.opponentId]].emit('get_questions', result, 'B');
                }

                //socket.quiz.push({ "QuizId": result.QuizId, "ProfileId": socket.profileId, UserAnswers: [] });
            });
        } else {
            io.sockets.connected[profileIds[socket.profileId]].emit('get_questions', getFakeQuestions().Data, 'A');
            io.sockets.connected[profileIds[socket.opponentId]].emit('get_questions', getFakeQuestions().Data, 'B');
        }
    });

    socket.on('cancel_waiting', function () {
        console.log("cancel_waiting")
        waitingList = waitingList.filter(q => q.ProfileId != socket.profileId);
        socket.timer = 0;
    });

    // when the user disconnects.. perform this
    socket.on('disconnect', function () {
        // remove the profileId from global profileIds list
        delete profileIds[socket.profileId];
        // update list of users in chat, client-side
        //io.sockets.emit('updateusers', profileIds);
        // echo globally that this client has left
        ////socket.broadcast.emit('updatechat', 'SERVER', socket.profileId + ' has disconnected');
        if (io.sockets.adapter.rooms['players'])
            io.to('players').emit('update_room_count', io.sockets.adapter.rooms['players'].length);
        if (socket.friendList) {
            socket.friendList.forEach(function (item) {
                if (item.IsOnline) {
                    if (io.sockets.connected[profileIds[item.FriendId]])
                        io.sockets.connected[profileIds[item.FriendId]].emit('notify_friend_list_updated');
                }
            });
        }
    });

});

http.listen(8008, function () {
    console.log('listening on *:8008');
});


function getFakeQuestions() {
    return {
        "Data": {
            "CatID": 23,
            "QuizId": 189624,
            "Questions": [
                {
                    "Level": 1,
                    "Option1": "مادربزرگ",
                    "Option2": "پدربزرگ",
                    "Option3": "پدر",
                    "Option4": "مادر",
                    "Answer": "مادربزرگ",
                    "QTitle": "در گویش هرمزگانی \"بی بی\" به چه معناست؟",
                    "QuestionID": 13561,
                    "OrderId": 1,
                    "Delay": 4
                },
                {
                    "Level": 1,
                    "Option1": "سر",
                    "Option2": "کبد",
                    "Option3": "قلوه",
                    "Option4": "گردن",
                    "Answer": "قلوه",
                    "QTitle": "در زبان مازندرانی \"قالوه\" به چه معناست؟",
                    "QuestionID": 13671,
                    "OrderId": 2,
                    "Delay": 4
                },
                {
                    "Level": 1,
                    "Option1": "صدف",
                    "Option2": "سوزن",
                    "Option3": "سنجاق",
                    "Option4": "هیچکدام",
                    "Answer": "سنجاق",
                    "QTitle": "در زبان گیلانی \"سونجاق\" به چه معناست؟",
                    "QuestionID": 13657,
                    "OrderId": 3,
                    "Delay": 4
                },
                {
                    "Level": 1,
                    "Option1": "پشت چشم تنک کردن",
                    "Option2": "چشم چرانی",
                    "Option3": "چشم پاکی",
                    "Option4": "با جنبه بودن",
                    "Answer": "پشت چشم تنک کردن",
                    "QTitle": "اصطلاح \"پوشت چشم تنوک کیدن \" در گویش نیشابوری به چه معناست؟",
                    "QuestionID": 13533,
                    "OrderId": 4,
                    "Delay": 4
                }
            ]
        },
        "Error": null,
        "HasError": false
    }
}
//////////// rejected: show list of available random players //////////
////user A
//socket.on('add_waiting_list', function (catId) {
//    add_waiting_list(catId)
//});

//function add_waiting_list(catId) {
//    var exists = false;
//    var profileIdExists = false;
//    $.each(waitingList, function (key, value) {
//        if (value.ProfileId == socket.profileId)
//            profileIdExists = true;
//        if (value.CatId == catId && value.ProfileId == socket.profileId)
//            exists = true;
//    });
//    if (!exists) {
//        if (profileIdExists) {
//            waitingList = waitingList.filter(q => q.ProfileId != socket.profileId);
//            waitingList.push({ "CatId": catId, "ProfileId": socket.profileId });
//        }
//        else
//            waitingList.push({ "CatId": catId, "ProfileId": socket.profileId });

//        io.sockets.emit('update_waiting_list', waitingList);
//    }
//    console.log('waitingList:' + JSON.stringify(waitingList));
//}

///////////////


