from definitions import FriendlyGreeter, Greeter


def announce(greeter: Greeter, name: str) -> str:
    return greeter.greet(name)


message = announce(FriendlyGreeter(), "Ada")
