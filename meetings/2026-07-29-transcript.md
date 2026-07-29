# Meeting Transcript — July 29, 2026

**Participants:** Eran, Or

---

**Or**
Let's make a transcript — it'll know how to read this.

**Eran**
Will it know how to do this from Zoom? As long as it can do it.

**Or**
It has "use me in transcript."

**Eran**
Okay, let's continue.

**Or**
So we're talking about this: in the first version we want to give a few things. First, at the team level, we want to provide some team context — whether it's team standards or team working procedures.

**Eran**
What goes into standards? What goes into Team Context in your view? You mentioned coding standards and working procedures.

**Or**
Coding standards is very tricky because you might have agents that aren't code agents, and then do you want to include coding standards for them? Say you want an agent that helps you do product research —

**Eran**
Okay.

**Or**
There's no point including coding standards there. But that's already at the agent level, not the team level. But in principle, it might need to be there.

**Eran**
A bank of skills — when you're building an agent you see a skills bank on the side, and you say: what capabilities do I want to give this agent? For a code agent I want to take coding skills.

**Or**
But we're talking about the team right now, not the agent. It could be that at the team level —

**Eran**
Maybe I don't need to define it there at all. That's what I'm saying — if there's nothing that necessarily applies to everyone, maybe there's no such thing as a team-level definition. Maybe it always lives as a skills bank — a pool of skills the team has built. Then tomorrow morning if it's a coding agent, I take the coding skill, the testing skill, and the requirements skill, and that creates the standard. I don't know — I'm following your thinking first, but then I question it, because I ask: what is a team standard? Is there something that necessarily applies always — to a presentation, a document, and code alike? I don't know. Good question.

**Or**
Fair enough. But either way, there's still value in team-level context. For example: the team's spec documents, the team's goal, the team's structure, what the team is responsible for, what it's trying to achieve — whether we're, say, a product team.

**Eran**
That's excellent — what you just did is frame the team context correctly. It's not about what actions it takes or its standards — it's about its framing: its objectives. What you just said is really beautiful, because that framing is something that at any point along the way the agent can reference, say "I want to do this," and it'll push back: "Wait — the team's goal is X, how does this connect?" It would either force you to connect it, or tell the user: "You're drifting from the team's goals." That's great. We need to think about what those things are — framing, objectives, north star metrics — things that truly live at the team level no matter what you write. That really resonated with me.

**Or**
Right. And I'm kind of thinking out loud — what do we want to put there? What is the agent's purpose? What is it supposed to do? In which areas of the code should it work? What are the relevant repositories?

**Eran**
Do you think that's specific to the agent or to the team?

**Or**
No, that's specific to the agent. Because an agent might be working on a task you don't fully understand. Say I'm a designer — I don't know where this task lives in the code, but I still want to assign it to the agent. The agent needs to know which code areas have been defined for it to complete its mission, so it searches in the right places. It shouldn't need to know at the task level exactly where a specific task sits in the code.

**Eran**
When I did that exercise yesterday —

**Or**
Because that information is very technical. Non-technical people won't have it, and even technical people won't always have it.

**Eran**
Understood. Because yesterday in my experiments I ended up defining that inside the task itself. But you're telling me: no, that belongs at a higher level.

**Or**
It depends on the task. If the task is very technically complex, you'll want to give the best possible guidance in the context.

**Eran**
Or you need to break it down. That's something I also want to discuss — from my experiments yesterday I concluded that this isn't trivial, and I think many people hit this problem. The challenge is they don't know where the agent's boundary is — when it will go off the rails and when it won't.

**Or**
Yes. Agreed.

**Eran**
And what's digestible?

**Or**
We need to define some level of work complexity that the agent evaluates in a kind of dry run. If you see, say — I'll give an example — I told it to do something and it creates 27 files. 27 files is a very large artifact of work. So maybe you need to break that down into sub-tasks, each smaller and more digestible, easier to assess and review. I'm talking in developer terms, but the same applies in product terms: if you generate a 100-page spec document, who's going to read 100 pages? You won't. You'd rather get a 3-page document on something smaller and focused — much easier to work with. So I really connect to what you said.

**Eran**
I don't even know if it's the same agent or not, but this is something I think users don't really understand today. If you don't know where the boundary is, you think it's fine, you let it run, and then you discover a huge mess. Part of the value here is saving those wasted runs that happen all the time today — just to discover a bad output.

**Or**
Yes.

**Eran**
Maybe it needs to come back and say: "This is too big, I suggest breaking it into 1, 2, 3." That worked well for me. So you're saying: first what you said — let's also take the code area thing up a level. That's something in the agent's definition itself, not in the task definition.

Yes. That's fine.

So we've talked about team definitions — not so much standards, more framing of who the team is, what the people are, their objectives, goals, and the metrics they're measured by. And honestly, that takes you to some very interesting places.

**Or**
Yes.

**Eran**
And in a perfect world, that's data flowing constantly — you'd think of metrics flowing all the time as additional context. If that's part of the agent's base definition, then it's always looking at those things.

**Or**
Yes. And in addition to that, the agent should receive some general context about its role, plus specific things — still role-related but with more rules. For example, if I'm an agent responsible for triaging tickets — stepping outside classic dev territory — then I need to know the ticket dashboard, the place where I centralize tickets. That's part of the context.

**Eran**
That you give the agent.

**Or**
Yes, exactly. The context should be general, not per-task. The task is: resolve ticket X, Y, Z.

**Eran**
Aren't you worried that if context always lives at the agent level, it could get too large?

**Or**
What do you mean?

**Eran**
That you give it all the designs, or all the Figma, or everything — not all at once, but even in a product with a reasonably sized spec that could bloat into something huge over time. You don't always want it looking at everything — maybe just a specific subset, a specific feature. The agent was originally connected to the entire PRD and maybe there's a limit. Maybe I'm wrong and you should always give it full context, but maybe it needs to be managed.

**Or**
I don't think you need to give it all the PRDs that exist. But there should be some kind of index — like we discussed yesterday — that says: if I'm working on a feature in the dependency area, I'd want the general dependency architecture in my context. That I would want.

**Eran**
Is that at the agent level or the task level?

**Or**
Agent level.

**Eran**
The agent is a code agent — it does coding tasks. You're telling me: when you assign something in the dependency area — do we give it the full dependency architecture context always, or is it that specifically this task warrants richer context, relevant only to this task, not to other tasks the same agent handles?

**Or**
Because it's a code agent, it does many things. If the agent is now working on a task relevant to dependencies —

**Eran**
Maybe we need both, Or.

**Or**
Both what?

**Eran**
You need context at the agent level, and also at the task level — allowing you to add more specific, richer context. Of course.

**Or**
At the task level you absolutely must give context. If I'm now coming to change the dependency graph, of course I need to give it a Figma. In the task — I can't expect it to guess what it looks like. I have to give it context.

**Eran**
So what context do we give at the agent level in this area, beyond coding standards, architecture decisions, or things like — how to do a PR?

**Or**
Well, architecture is exactly what I talked about. You don't need much more than that. Just staying with the same example: you define in its context that everything related to the dependency layer lives under repository XYZ. That's context for it — so when it now does a dependency task, you surface a Figma of what you want to change, and it knows where to go. You focus it, help it, direct it to the right place, and it solves the problem.

**Eran**
So when you build that coding agent, it doesn't just come with coding standards and a general repo overview — you literally tell it: "dependencies are here, this is there, that is there." That's very specific.

**Or**
That's very difficult — you can't build that for the customer, you understand?

**Eran**
No — the customer builds it for themselves.

**Or**
The customer builds it for themselves.

**Eran**
Maybe at first you give it something like: map the entire repo and suggest — what features are here, what things are here, what areas. Save that so that every time a future task is triggered, it doesn't have to re-download everything. It'll say: "Dependencies — I know, it's here, I already did this work."

**Or**
That's exactly the challenge: how to help users do this setup in a way that gives them a high-quality agent. Because generating context for an agent and feeding it the system in a way that makes it as good as possible as quickly as possible — that's really hard.

**Eran**
If you gave an agent today a repo like this — I don't know how it would run for us in size — but to run across everything, map it, and say: "These are features 1, 2, 3, 4; this is dependencies; this is..." — that could be the full context of what lives here. And eventually context plus customer feedback and other things — you know, as it grows over time.

**Or**
That's basically what we did — that's how we worked. But it's an iterative process, it takes time. Maybe as part of onboarding we need to productize this — some kind of workflow where the agent, as part of onboarding, asks you: what repos do you work on? What is your team responsible for? Let's map what your team owns to where things live in the code. Or let's map where you as a team store product documents.

**Eran**
And associate each area — dependency is here, this is saved here, etc. — and then fill in the gaps: where are the dependency docs? Then it knows how to retrieve them every time.

**Or**
Yes.

**Eran**
Okay.

**Or**
The onboarding process is actually a nice product problem.

**Eran**
Good. Let's think for a second — let's first create our workflow for what's "synchronic," because we both get blocked at different hours. I got blocked at like 2 in the morning and it told me I'd have more compute in an hour and a half. I said okay, I'll deal — but yes, that happened to me around 2am. Do we want first to put this somewhere — some free website — where we can play with it and see how it works? Or would it be possible to actually do this already but it requires subscriptions and APIs and...

**Or**
We'll put it somewhere once we have something that works end-to-end. Right now I think there are... I'm uploading this to Claude via GitHub and running it — as soon as I have something —

**Eran**
Some kind of... yes, that's what I did.

**Or**
Some end-to-end thing that I or you or Uri can start working with.

**Eran**
Yes. So I'm trying to think about our next step. I said: okay, I have some idea for how to share with Or now — we've been at this for 20 minutes, I hadn't managed to share with you how I'm thinking. First: do we agree on the direction? Let me quickly summarize what I have before this disconnects. What is this? "Limit time saving, unlock premium 10 GB for cloud storage."

**Or**
That's like a countdown timer.

**Eran**
There it is, it just counted down. Yes, I see — I was working on a one-on-one meeting, they were running in parallel. So: how do we work — both the synchronous part? First, finish a feature list, or describe a roadmap of sorts. We're now in the Ideation phase and haven't gotten to — what's it called — Structure, where we're not yet at the feature list. Need to think about how to do that so we can work properly.

**Or**
Synchronously. Actually, I think for now just uploading artifacts like you did, then sending each other the link on WhatsApp.

**Eran**
How do I make a change without messing up what you already built? Because I could've said no, don't change the document — I didn't want that. I wanted us to first agree on a direction. Could I have stopped there with two different versions? Actually that's not the right way to do it.

**Or**
I think we should decide on a direction first and then start building on it. No point generating multiple versions.

**Eran**
True. Actually I want to share something with you now but I can't because in my Zoom settings it forces me to close and reopen first. Regarding the left pane: I'll start with what you told me — whether it's execution or really a task list. My product instinct says no customer is going to replace their Jira with this tomorrow.

**Or**
Not going to happen. Exactly. I don't want that either.

**Eran**
Because that's an adoption blocker. It's a waste of time.

**Or**
But on the other hand —

**Eran**
Does this go into sync integrations? Because I don't believe — no one syncs their Jira. Jira is Jira, and this thing, which is supposed to take tasks from it, is essentially a kind of execution platform. Sort of.

**Or**
What — basically, the most basic thing you can do, I think, is copy-paste from Jira to the agent's chat. If you have documents, upload them from your computer. That's the easiest proof of concept. After that I think... I don't know, I believe that — just, in my own work with agents, in the first phase I worked through Slack. I wasn't triggering tasks through Slack, that was the most convenient for me — I didn't want to go to a separate app.

**Eran**
Do you need that immediately? If yes, then yes. Do you need it immediately?

**Or**
No, I don't think so. I don't think I need it immediately. But I'm saying — in my evolution it went: started through the app directly, realized it wasn't convenient, moved to Slack, and then the next step was Monday.

**Eran**
Yes.

**Or**
I was triggering tasks through Monday. Each has its pros and cons — skip the app, I don't want to work there. But Slack vs. Monday — each has its pros and cons. Slack is much more accessible, available even remotely.

**Eran**
Yes, and with Monday it's more organized, you can see the tasks.

**Or**
Right.

**Eran**
Sure.

**Or**
Like that.

**Eran**
Right. But you understand — this execution system is not a management system. I agree — I'm not trying to replace Jira. That's my position. At the start — as you said — proof of concept is copy-paste. "Create the task right now with copy-paste" — yes, that's life. But let's see that it actually works for you and creates value. Okay?

**Or**
The distance between that and making it a sync integration isn't large, it's not hard.

**Eran**
Yes, but that's investing in something that's currently not in the critical path. That's exactly the point — you need to identify what's critical vs. what's important.

**Or**
Exactly.

**Eran**
Ultimately I have some thesis, and I either prove it or disprove it. If I prove it, I push forward; if I disprove it, I was wrong and users aren't interested, need to change direction.

**Or**
Yes.

**Eran**
Okay, so what did we agree is important? Let me quickly summarize before the session ends. We said: context — there's first some team framework. Talked about that. Talked about context flowing to the agent. Talked about the agent having some mapping of different context types across different features or code areas. That's not a one-time thing — you need to think about how to maintain it continuously, because it always needs to know a place that maps its entire world, so if tomorrow it's triggered to work on feature A or feature B, it knows how to pull different contexts. Context is: code, metrics, designs, architecture, customer conversations, feedback, PRDs — everything can be there.

What happens if you give it a new task it doesn't recognize? That's also a question.

I'm thinking, and we want that. Maybe not in phase one, but it's something to think about. Yes.

Because suddenly you give it something about dependencies that it doesn't know. I don't know — I don't have documents, nothing here, nothing there.

It also needs to know to say it doesn't recognize something. Normally it'll say "I don't know," but it'll actually do something that seems reasonable to it. Yes. That also needs to be controlled — in the system prompt — think about how to handle it.

Alright. So regarding the left pane: what bothered me is that tasks and sub-tasks both sit below, but I do understand that sub-tasks — if a task is too big and the agent decides to fork it — it becomes sub-tasks. That's what we said earlier. Are you familiar with MLS? I didn't make multiple levels here — just one. Though I did include that Kanban format, I'm actually against it — I think linear sequential tasks in a table works better for me. Good enough for now as a start. When you click on a task, if it hasn't started yet, you can trigger it. If it's started, you see the activity — what's happening, where it stands. Actually wait, I changed a few things — let me send you the new version.

**Or**
Where did you put the agents? From 1P?

**Eran**
They're inside Settings.

**Or**
Settings of what?

**Eran**
There's Settings on the left. You see? No, but...

**Or**
Okay.

**Eran**
You know they need to come out. No idea. This is just some experiment. If they're inside Settings, look at 5A.

**Or**
But wait — you only have two there.

**Eran**
There's Code Implementer, Code Reviewer, and New Agent. Yes. I don't know how to tell Claude to put this into the repo so you can also play with it — I'll do an experiment shortly.

**Or**
I don't connect much to this design, but —

**Eran**
What? Forget the actual boxes — the logic I tried to follow: first, if you look at 1A, it's basically the task list, where a task is potentially a mission — a task the agent can run on. Open it, defined for it — if you now jump to 1C, let me pull it down. In 1C, you create the task, define the mission, define which agent, codebase — you said we'd take that out from here — context documents can be added here too. And you said that context can also exist at the task level, which we never want to remove.

**Or**
What?

**Eran**
Context documents can exist at the task level. Of course. Okay. And then you have...

**Or**
But here, in the task definition screen, you're already forcing me to do an agent assignment?

**Eran**
No — that's an example. If I assigned to an agent, then it starts running.

**Or**
Okay, so if I haven't done it yet — where do I do it?

**Eran**
You can do it from the same board — from 1A. You can say, for example, let's say we're not doing that now — you can add it without an assignment. I see it didn't render the UI element here, we can add that. Okay. The idea is —
