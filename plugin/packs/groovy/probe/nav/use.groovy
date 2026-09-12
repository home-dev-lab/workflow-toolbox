String announce(Greeter greeter, String name) {
  greeter.greet(name)
}

def message = announce(new FriendlyGreeter(), 'Ada')
