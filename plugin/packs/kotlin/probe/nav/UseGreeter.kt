fun announce(greeter: Greeter, name: String) = greeter.greet(name)

val message = announce(FriendlyGreeter(), "Ada")
